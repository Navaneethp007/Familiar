import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  classifyCommand,
  drainSpool,
  eventsFromSpool,
  normaliseRepoPath,
  parseSpoolLine,
  SHELL_CURSOR_KEY,
} from '../src/adapters/terminal.js';
import { foldChecks, summariseChecks } from '../src/core/checks.js';
import type { CursorFile } from '../src/state/config.js';
import { appendEvents, readEvents } from '../src/state/log.js';
import { shellLogPath } from '../src/state/paths.js';
import { useTempHome } from './helpers.js';

let home: ReturnType<typeof useTempHome>;

beforeEach(() => {
  home = useTempHome();
});

afterEach(() => {
  home.cleanup();
});

const line = (parts: (string | number)[]): string => parts.join('\t');

describe('classifyCommand', () => {
  it('recognises test runners', () => {
    for (const command of [
      'npm test',
      'npm run test',
      'pnpm test',
      'yarn test',
      'npx vitest run',
      'jest --ci',
      'pytest -q',
      'go test ./...',
      'cargo test',
      'dotnet test',
      'bundle exec rspec',
      'phpunit',
    ]) {
      expect(classifyCommand(command), command).toBe('test');
    }
  });

  it('recognises typechecks ahead of builds', () => {
    // "npm run typecheck" mentions neither tsc nor build directly, and
    // ordering matters: a typecheck script must not be filed as a build.
    for (const command of ['tsc --noEmit', 'npm run typecheck', 'npm run type-check', 'mypy src']) {
      expect(classifyCommand(command), command).toBe('typecheck');
    }
  });

  it('recognises lint and build', () => {
    expect(classifyCommand('eslint .')).toBe('lint');
    expect(classifyCommand('cargo clippy')).toBe('lint');
    expect(classifyCommand('npm run build')).toBe('build');
    expect(classifyCommand('go build ./...')).toBe('build');
  });

  it('ignores commands that are not checks', () => {
    for (const command of ['git status', 'ls -la', 'npm install', 'cd ..', 'echo hi']) {
      expect(classifyCommand(command), command).toBeNull();
    }
  });

  // A watcher's exit code means "you pressed Ctrl-C", not "the tests failed".
  // Recording that as a red would manufacture fixes out of nothing.
  it('ignores watchers, whose exit code means nothing', () => {
    for (const command of [
      'npm run test:watch',
      'vitest --watch',
      'jest --watch',
      'nodemon src/index.ts',
      'npm test -- -w',
    ]) {
      expect(classifyCommand(command), command).toBeNull();
    }
  });
});

describe('parseSpoolLine', () => {
  it('parses a well-formed line', () => {
    const parsed = parseSpoolLine(line([1753849302411, 0, 'claude-code', 'C:/repo', 'npm test']));
    expect(parsed).not.toBeNull();
    expect(parsed?.exitCode).toBe(0);
    expect(parsed?.agent).toBe('claude-code');
    expect(parsed?.cwd).toBe('C:/repo');
    expect(parsed?.command).toBe('npm test');
  });

  it('reads a dash as no agent', () => {
    expect(parseSpoolLine(line([1753849302411, 0, '-', '/r', 'npm test']))?.agent).toBeNull();
  });

  it('does not trust an unknown agent name', () => {
    expect(parseSpoolLine(line([1753849302411, 0, 'evil', '/r', 'npm test']))?.agent).toBeNull();
  });

  it('keeps a command that itself contains a tab', () => {
    const parsed = parseSpoolLine('1753849302411\t0\t-\t/r\tnpm test\t--reporter=dot');
    expect(parsed?.command).toBe('npm test\t--reporter=dot');
  });

  it('rejects malformed lines rather than throwing', () => {
    for (const bad of [
      '',
      '   ',
      'garbage',
      'a\tb\tc',
      line(['notanumber', 0, '-', '/r', 'npm test']),
      line([1753849302411, 'nope', '-', '/r', 'npm test']),
      line([1753849302411, 0, '-', '', 'npm test']),
      line([1753849302411, 0, '-', '/r', '']),
      line([-5, 0, '-', '/r', 'npm test']),
    ]) {
      expect(parseSpoolLine(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('tolerates a trailing carriage return', () => {
    expect(parseSpoolLine(line([1753849302411, 0, '-', '/r', 'npm test']) + '\r')).not.toBeNull();
  });
});

describe('eventsFromSpool', () => {
  it('turns exit codes into pass and fail observations', () => {
    const text = [
      line([1753849302411, 1, '-', 'C:/repo', 'npm test']),
      line([1753849402411, 0, '-', 'C:/repo', 'npm test']),
      '',
    ].join('\n');

    const events = eventsFromSpool(text);
    expect(events.map((e) => e.type)).toEqual(['check_failed', 'check_passed']);
    expect(events[0]?.meta['kind']).toBe('test');
    expect(events[0]?.source).toBe('terminal');
  });

  it('normalises backslashes so both adapters agree on the repo', () => {
    const events = eventsFromSpool(line([1753849302411, 0, '-', 'C:\\repo\\thing\\', 'npm test']));
    expect(events[0]?.meta.repoPath).toBe('C:/repo/thing');
    expect(events[0]?.meta.repo).toBe('thing');
  });

  // Git Bash says /c/Users/you/repo, git and PowerShell say C:/Users/you/repo.
  // If these stay different strings, a red logged in one shell can never be
  // fixed by a green in the other — the transition is simply never seen.
  it('folds a Git Bash path onto the same repo as a Windows one', () => {
    const posix = eventsFromSpool(line([1753849302411, 1, '-', '/c/Users/me/repo', 'npm test']));
    const windows = eventsFromSpool(line([1753849402411, 0, '-', 'C:\\Users\\me\\repo', 'npm test']));

    expect(posix[0]?.meta.repoPath).toBe('C:/Users/me/repo');
    expect(windows[0]?.meta.repoPath).toBe(posix[0]?.meta.repoPath);
  });

  it('agrees on drive letter case', () => {
    expect(normaliseRepoPath('c:/repo')).toBe('C:/repo');
    expect(normaliseRepoPath('/c/repo')).toBe('C:/repo');
    expect(normaliseRepoPath('C:\\repo\\')).toBe('C:/repo');
    // Genuine POSIX paths must survive untouched.
    expect(normaliseRepoPath('/home/me/repo')).toBe('/home/me/repo');
  });

  it('lets a red in one shell be fixed by a green in the other', () => {
    const events = [
      ...eventsFromSpool(line([1753849302411, 1, '-', '/c/Users/me/repo', 'npm test'])),
      ...eventsFromSpool(line([1753849402411, 0, '-', 'C:\\Users\\me\\repo', 'npm test'])),
    ];
    expect(summariseChecks(foldChecks(events)).fixes).toBe(1);
  });

  it('skips lines that are not checks', () => {
    const text = [
      line([1753849302411, 0, '-', '/r', 'git status']),
      line([1753849302412, 0, '-', '/r', 'npm test']),
    ].join('\n');
    expect(eventsFromSpool(text)).toHaveLength(1);
  });

  it('produces the same key for the same line every time', () => {
    const raw = line([1753849302411, 0, '-', '/r', 'npm test']);
    expect(eventsFromSpool(raw)[0]?.key).toBe(eventsFromSpool(raw)[0]?.key);
    expect(eventsFromSpool(raw)[0]?.key).not.toBe(
      eventsFromSpool(line([1753849302412, 0, '-', '/r', 'npm test']))[0]?.key,
    );
  });

  it('never throws on garbage', () => {
    expect(() => eventsFromSpool('\u0000\u0001binary\n{{{\n\n')).not.toThrow();
    expect(eventsFromSpool('\u0000\u0001binary\n{{{\n\n')).toEqual([]);
  });
});

describe('drainSpool', () => {
  function writeSpool(...lines: string[]): void {
    writeFileSync(shellLogPath(), lines.join('\n') + '\n', 'utf8');
  }

  it('returns nothing when there is no spool', () => {
    expect(drainSpool({}).events).toEqual([]);
  });

  it('reads everything on the first drain', () => {
    writeSpool(line([1753849302411, 0, '-', '/r', 'npm test']));
    expect(drainSpool({}).events).toHaveLength(1);
  });

  it('reads only what is new on the next drain', () => {
    const cursors: CursorFile = {};
    writeSpool(line([1753849302411, 0, '-', '/r', 'npm test']));
    expect(drainSpool(cursors).events).toHaveLength(1);
    expect(drainSpool(cursors).events).toHaveLength(0);

    appendFileSync(shellLogPath(), line([1753849402411, 1, '-', '/r', 'npm test']) + '\n');
    expect(drainSpool(cursors).events).toHaveLength(1);
    expect(drainSpool(cursors).events).toHaveLength(0);
  });

  it('leaves a half-written final line for next time', () => {
    const cursors: CursorFile = {};
    writeFileSync(
      shellLogPath(),
      line([1753849302411, 0, '-', '/r', 'npm test']) + '\n' + '1753849402411\t0\t-\t/r\tnpm te',
      'utf8',
    );
    expect(drainSpool(cursors).events).toHaveLength(1);

    // The shell finishes writing it.
    appendFileSync(shellLogPath(), 'st\n');
    const second = drainSpool(cursors).events;
    expect(second).toHaveLength(1);
    expect(second[0]?.meta['command']).toBe('npm test');
  });

  it('starts over when the spool has been truncated', () => {
    const cursors: CursorFile = {};
    writeSpool(
      line([1753849302411, 0, '-', '/r', 'npm test']),
      line([1753849402411, 1, '-', '/r', 'npm test']),
    );
    drainSpool(cursors);

    writeSpool(line([1753849502411, 0, '-', '/r', 'npm test']));
    const result = drainSpool(cursors);
    expect(result.reset).toBe(true);
    expect(result.events).toHaveLength(1);
  });

  it('re-ingesting after a reset adds nothing to the log', () => {
    // Content-derived keys are what make starting over safe.
    const cursors: CursorFile = {};
    writeSpool(line([1753849302411, 0, '-', '/r', 'npm test']));
    appendEvents(drainSpool(cursors).events);
    expect(readEvents()).toHaveLength(1);

    cursors[SHELL_CURSOR_KEY] = { lastSha: '999999', lastScan: '' };
    appendEvents(drainSpool(cursors).events);
    expect(readEvents()).toHaveLength(1);
  });

  it('survives a corrupt cursor value', () => {
    const cursors: CursorFile = { [SHELL_CURSOR_KEY]: { lastSha: 'not-a-number', lastScan: '' } };
    writeSpool(line([1753849302411, 0, '-', '/r', 'npm test']));
    expect(drainSpool(cursors).events).toHaveLength(1);
  });

  it('handles a spool with no trailing newline', () => {
    writeFileSync(shellLogPath(), line([1753849302411, 0, '-', '/r', 'npm test']), 'utf8');
    // No newline means the line may still be mid-write, so it waits.
    expect(drainSpool({}).events).toHaveLength(0);
  });

  it('does not rewrite the spool', () => {
    const path = join(home.dir, 'shell.log');
    writeSpool(line([1753849302411, 0, '-', '/r', 'npm test']));
    const before = readEvents(path);
    drainSpool({});
    // The adapter only ever moves a byte offset; a shell could be appending
    // at this very moment and a read-modify-write would lose it.
    expect(readEvents(path)).toEqual(before);
  });
});

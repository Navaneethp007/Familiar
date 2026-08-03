/**
 * Runs the shell snippets in real shells.
 *
 * String-comparing generated shell code proves nothing — the failure modes
 * that matter (a quoting slip, a builtin that behaves differently, clobbering
 * the exit code) only appear when a shell actually executes it.
 *
 * bash gets a genuine interactive session. PowerShell cannot: `Get-History`
 * returns nothing in a non-interactive process, so the prompt path is driven
 * through injected history instead, and the fully interactive behaviour stays
 * a manual check. That limit is stated rather than papered over.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { eventsFromSpool } from '../src/adapters/terminal.js';
import { foldChecks, summariseChecks } from '../src/core/checks.js';
import { bashSnippet, powershellSnippet } from '../src/shell/snippets.js';

let home: string;
let work: string;

function which(command: string): string | null {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [command], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = out.split('\n')[0]?.trim();
    return first && first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

/**
 * On Windows `where bash` finds `C:\Windows\System32\bash.exe`, which is the
 * WSL launcher — a different filesystem where `C:/...` does not exist and
 * `/c/...` is `/mnt/c`. Testing the snippet there proves nothing about the
 * shell Claude Code and Git for Windows actually use, so Git Bash is resolved
 * explicitly and the WSL stub is skipped.
 */
function findBash(): string | null {
  if (process.platform === 'win32') {
    const git = which('git');
    if (git) {
      const root = dirname(dirname(git)); // .../Git/cmd/git.exe -> .../Git
      for (const candidate of [join(root, 'bin', 'bash.exe'), join(root, 'usr', 'bin', 'bash.exe')]) {
        if (existsSync(candidate)) return candidate;
      }
    }
    for (const candidate of [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ]) {
      if (existsSync(candidate)) return candidate;
    }
    const onPath = which('bash');
    return onPath && !/system32/i.test(onPath) ? onPath : null;
  }
  return which('bash');
}

const BASH = findBash();
const POWERSHELL = which('powershell') ?? which('pwsh');

function spool(): string {
  const path = join(home, 'shell.log');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/**
 * Git Bash cannot open `C:\Users\...\rc.sh` — the backslashes are escapes, so
 * `--rcfile` silently loads nothing and the snippet never gets a chance to
 * run. Paths handed to bash have to be POSIX.
 */
function toPosix(winPath: string): string {
  const forward = winPath.replace(/\\/g, '/');
  const drive = /^([A-Za-z]):\/(.*)$/.exec(forward);
  return drive ? `/${drive[1]!.toLowerCase()}/${drive[2]}` : forward;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'familiar-shell-'));
  work = mkdtempSync(join(tmpdir(), 'familiar-work-'));
});

/**
 * A shell we just spawned may still hold a handle briefly, and Windows raises
 * EBUSY rather than deleting anyway. A leftover temp dir is not worth failing
 * a test over.
 */
function removeQuietly(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* the OS will clear it out eventually */
  }
}

afterEach(() => {
  removeQuietly(home);
  removeQuietly(work);
});

describe.runIf(BASH)('bash, for real', () => {
  /**
   * Commands go in on stdin, not as a script file.
   *
   * PROMPT_COMMAND only fires when bash draws a prompt, and running a script
   * never draws one — so `bash -i script.sh` would exercise nothing. Feeding
   * stdin to an interactive shell gives a prompt between each command, which
   * is the thing being tested.
   */
  function runInteractive(commands: string[], extraEnv: Record<string, string> = {}): string {
    const rcPath = join(work, 'rc.sh');
    writeFileSync(rcPath, bashSnippet() + '\n', 'utf8');

    // History is off by default when stdin is not a terminal, and the snippet
    // reads the last history entry to learn what ran.
    const input = ['set +e', 'set -o history', ...commands, 'exit 0', ''].join('\n');

    try {
      // Long option first: `bash -i --rcfile x -s` is rejected as an invalid
      // option, `bash --rcfile x -i -s` is not.
      execFileSync(BASH!, ['--rcfile', toPosix(rcPath), '-i', '-s'], {
        cwd: work,
        input,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          FAMILIAR_HOME: home,
          HOME: toPosix(home),
          CLAUDECODE: '',
          HISTFILE: toPosix(join(work, '.hist')),
          ...extraEnv,
        },
        timeout: 20_000,
      });
    } catch {
      // A non-zero exit from a deliberately failing command is expected.
    }
    return spool();
  }

  it('logs a failing then a passing check', () => {
    const log = runInteractive(['false # npm test', 'true # npm test']);
    const events = eventsFromSpool(log);

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.map((e) => e.type)).toContain('check_failed');
    expect(events.map((e) => e.type)).toContain('check_passed');
  });

  it('records the real exit code', () => {
    const log = runInteractive(['(exit 3) # npm test']);
    const parsed = eventsFromSpool(log);
    expect(parsed[0]?.meta['exitCode']).toBe(3);
    expect(parsed[0]?.type).toBe('check_failed');
  });

  it('ignores commands that are not checks', () => {
    const log = runInteractive(['true # git status', 'ls > /dev/null']);
    expect(eventsFromSpool(log)).toHaveLength(0);
  });

  it('keeps identical commands in the same second distinct', () => {
    // Lines are deduplicated by content, so a second-resolution timestamp
    // would silently merge these and undercount the attempts a fix took.
    const log = runInteractive([
      '(exit 1) # npm test',
      '(exit 1) # npm test',
      '(exit 1) # npm test',
      'true # npm test',
    ]);
    const events = eventsFromSpool(log);
    expect(events.filter((e) => e.type === 'check_failed')).toHaveLength(3);
    expect(summariseChecks(foldChecks(events)).lastFix?.attempts).toBe(3);
  });

  it('does not clobber $? for the rest of the prompt', () => {
    // The snippet runs first in PROMPT_COMMAND. If it leaked its own status,
    // the command afterwards would see 0 instead of the real 7.
    const rcPath = join(work, 'rc2.sh');
    writeFileSync(rcPath, bashSnippet() + '\n', 'utf8');

    let stdout = '';
    try {
      stdout = execFileSync(BASH!, ['--rcfile', rcPath, '-i', '-s'], {
        cwd: work,
        input: ['set +e', 'set -o history', '(exit 7) # npm test', 'echo "PROBE=$?"', 'exit 0', ''].join('\n'),
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          FAMILIAR_HOME: home,
          HOME: toPosix(home),
          HISTFILE: toPosix(join(work, '.hist2')),
        },
        timeout: 20_000,
      });
    } catch (error) {
      stdout = String((error as { stdout?: string }).stdout ?? '');
    }
    expect(stdout).toContain('PROBE=7');
  });

  it('marks an agent when the environment says so', () => {
    const log = runInteractive(['true # npm test'], { CLAUDECODE: '1' });
    const events = eventsFromSpool(log);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.meta['agent']).toBe('claude-code');
  });

  it('writes nothing when the state directory is missing', () => {
    rmSync(home, { recursive: true, force: true });
    const log = runInteractive(['true # npm test']);
    expect(log).toBe('');
  });
});

describe.runIf(POWERSHELL)('powershell', () => {
  /**
   * Drives the logging function directly. `Get-History` is empty in a
   * non-interactive process, so the prompt wrapper cannot be exercised here —
   * see the manual verification steps for that half.
   */
  function runLogging(exitCode: number, command: string, extraEnv: Record<string, string> = {}): string {
    const scriptPath = join(work, 'drive.ps1');
    writeFileSync(
      scriptPath,
      [powershellSnippet(), `__familiarLog ${exitCode} ${JSON.stringify(command)}`].join('\n'),
      'utf8',
    );

    // Bypass because -File runs a script we wrote to a temp dir a line ago, and
    // the Windows default (AllSigned / RemoteSigned) refuses to run it unsigned.
    // Without this the suite is red on a stock Windows machine — and green under
    // any shell that already set a Bypass process policy, which hides it.
    execFileSync(
      POWERSHELL!,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      {
        cwd: work,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FAMILIAR_HOME: home, ...extraEnv },
        timeout: 30_000,
      },
    );
    return spool();
  }

  it('logs a check command with its exit code', () => {
    const events = eventsFromSpool(runLogging(1, 'npm test'));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('check_failed');
    expect(events[0]?.meta['kind']).toBe('test');
  });

  it('logs a passing check', () => {
    const events = eventsFromSpool(runLogging(0, 'npm run build'));
    expect(events[0]?.type).toBe('check_passed');
    expect(events[0]?.meta['kind']).toBe('build');
  });

  it('ignores commands that are not checks', () => {
    expect(runLogging(0, 'git status').trim()).toBe('');
  });

  it('flattens a multi-line command onto one record', () => {
    const log = runLogging(0, "npm test `n--reporter=dot");
    expect(log.split('\n').filter((l) => l.trim().length > 0)).toHaveLength(1);
  });

  it('marks an agent from the environment', () => {
    const events = eventsFromSpool(runLogging(0, 'npm test', { CLAUDECODE: '1' }));
    expect(events[0]?.meta['agent']).toBe('claude-code');
  });

  it('writes nothing when the state directory is missing', () => {
    rmSync(home, { recursive: true, force: true });
    expect(runLogging(0, 'npm test')).toBe('');
  });

  it('the snippet parses as valid PowerShell', () => {
    // A syntax error here would break every new shell the user opens.
    const scriptPath = join(work, 'parse.ps1');
    writeFileSync(scriptPath, powershellSnippet(), 'utf8');
    expect(() =>
      execFileSync(
        POWERSHELL!,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$errors = $null; [System.Management.Automation.PSParser]::Tokenize((Get-Content -Raw ${JSON.stringify(scriptPath)}), [ref]$errors) | Out-Null; if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }`,
        ],
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
      ),
    ).not.toThrow();
  });
});

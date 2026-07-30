import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commitDatesSince, discoverRepos, findRepoRoot, headSha, looksLikeTestFile, scanRepo } from '../src/adapters/git.js';
import type { CursorFile } from '../src/state/config.js';
import { tempDir, useTempHome } from './helpers.js';

let home: ReturnType<typeof useTempHome>;
let repo: string;

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

function commit(file: string, message: string, date = '2026-07-15T02:30:00'): void {
  const full = join(repo, file);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, `${message}\n${Math.random()}`, 'utf8');
  git(['add', '-A']);
  git(['-c', `user.name=Test`, '-c', `user.email=test@example.com`, 'commit', '-m', message, '--date', date]);
}

beforeEach(() => {
  home = useTempHome();
  repo = tempDir('familiar-repo-');
  git(['init', '-q', '-b', 'main'], repo);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'commit.gpgsign', 'false']);
  commit('README.md', 'initial');
});

afterEach(() => {
  home.cleanup();
  rmSync(repo, { recursive: true, force: true });
});

describe('looksLikeTestFile', () => {
  it('recognises the usual conventions', () => {
    for (const path of [
      'tests/foo.ts',
      'test/foo.py',
      'src/__tests__/a.tsx',
      'spec/models/user_spec.rb',
      'src/thing.test.ts',
      'src/thing.spec.js',
      'src\\nested\\tests\\x.go',
    ]) {
      expect(looksLikeTestFile(path), path).toBe(true);
    }
  });

  it('does not fire on ordinary source files', () => {
    for (const path of ['src/index.ts', 'lib/latest.ts', 'docs/protest.md', 'src/contested.ts']) {
      expect(looksLikeTestFile(path), path).toBe(false);
    }
  });
});

describe('findRepoRoot', () => {
  it('finds the root from a nested directory', () => {
    const nested = join(repo, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    expect(findRepoRoot(nested)?.toLowerCase()).toBe(findRepoRoot(repo)?.toLowerCase());
  });

  it('returns null outside a repo', () => {
    const plain = tempDir('familiar-plain-');
    expect(findRepoRoot(plain)).toBeNull();
    rmSync(plain, { recursive: true, force: true });
  });

  it('returns null for a directory that does not exist', () => {
    expect(findRepoRoot(join(repo, 'nope', 'nope'))).toBeNull();
  });
});

describe('scanRepo', () => {
  it('emits nothing on the first scan and records HEAD', () => {
    const cursors: CursorFile = {};
    const result = scanRepo(repo, cursors);
    // History seeds personality, not level. A first scan must never backfill XP.
    expect(result.seeded).toBe(true);
    expect(result.events).toHaveLength(0);
    expect(cursors[repo]?.lastSha).toBe(headSha(repo));
  });

  it('emits only commits made after the cursor', () => {
    const cursors: CursorFile = {};
    scanRepo(repo, cursors);

    commit('src/a.ts', 'add a');
    commit('src/b.ts', 'add b');

    const result = scanRepo(repo, cursors);
    expect(result.events).toHaveLength(2);
    expect(result.events.every((e) => e.type === 'commit')).toBe(true);
    expect(result.events.map((e) => e.meta.repo)).toEqual([expect.any(String), expect.any(String)]);
  });

  it('is a no-op when nothing has changed', () => {
    const cursors: CursorFile = {};
    scanRepo(repo, cursors);
    commit('src/a.ts', 'add a');
    expect(scanRepo(repo, cursors).events).toHaveLength(1);
    expect(scanRepo(repo, cursors).events).toHaveLength(0);
    expect(scanRepo(repo, cursors).events).toHaveLength(0);
  });

  it('keys commits on their SHA so a rescan cannot double-count', () => {
    const start = headSha(repo);
    const cursors: CursorFile = { [repo]: { lastSha: start, lastScan: '' } };

    commit('src/a.ts', 'add a');
    commit('src/b.ts', 'add b');
    const first = scanRepo(repo, cursors).events;
    expect(first).toHaveLength(2);

    // Rewind to the same starting point and scan the identical range again.
    const rewound: CursorFile = { [repo]: { lastSha: start, lastScan: '' } };
    const again = scanRepo(repo, rewound).events;

    // Identical keys, so appendEvents will discard every one of them.
    expect(again.map((e) => e.key)).toEqual(first.map((e) => e.key));
    expect(new Set([...first, ...again].map((e) => e.key)).size).toBe(2);
  });

  it('flags commits that touch test files', () => {
    const cursors: CursorFile = {};
    scanRepo(repo, cursors);
    commit('tests/thing.test.ts', 'add a test');
    commit('src/plain.ts', 'add source');

    const events = scanRepo(repo, cursors).events;
    expect(events.find((e) => e.meta.sha && e.meta.touchedTests === true)).toBeDefined();
    expect(events.filter((e) => e.meta.touchedTests === true)).toHaveLength(1);
  });

  it('records the local hour of each commit', () => {
    const cursors: CursorFile = {};
    scanRepo(repo, cursors);
    commit('src/night.ts', 'late work', '2026-07-15T02:30:00');
    const event = scanRepo(repo, cursors).events[0];
    expect(typeof event?.meta.hour).toBe('number');
    expect(event?.meta.hour).toBeGreaterThanOrEqual(0);
    expect(event?.meta.hour).toBeLessThanOrEqual(23);
  });

  it('reports a merged pull request instead of a plain commit', () => {
    const cursors: CursorFile = {};
    scanRepo(repo, cursors);

    git(['checkout', '-q', '-b', 'feature']);
    commit('src/feature.ts', 'feature work');
    git(['checkout', '-q', 'main']);
    git(['merge', '--no-ff', '-m', 'Merge pull request #42 from user/feature', 'feature']);

    const events = scanRepo(repo, cursors).events;
    const merged = events.filter((e) => e.type === 'pr_merged');
    expect(merged).toHaveLength(1);
    expect(merged[0]?.meta.pr).toBe(42);
    // The branch commit still counts; only the merge commit is reclassified.
    expect(events.filter((e) => e.type === 'commit')).toHaveLength(1);
  });

  it('seeds rather than replaying when the cursor has no SHA', () => {
    // Happens when a repo had no commits at init time, or git was unreadable.
    // Replaying from HEAD here would backfill the entire history as XP.
    commit('src/a.ts', 'a');
    commit('src/b.ts', 'b');

    const cursors: CursorFile = { [repo]: { lastSha: null, lastScan: '' } };
    const result = scanRepo(repo, cursors);

    expect(result.seeded).toBe(true);
    expect(result.events).toHaveLength(0);
    expect(cursors[repo]?.lastSha).toBe(headSha(repo));
  });

  it('starts counting a previously empty repo from its first commit', () => {
    const empty = tempDir('familiar-empty-');
    git(['init', '-q', '-b', 'main'], empty);
    const cursors: CursorFile = {};

    // Nothing to see yet.
    expect(scanRepo(empty, cursors).events).toHaveLength(0);

    writeFileSync(join(empty, 'a.txt'), 'hello', 'utf8');
    git(['add', '-A'], empty);
    git(['-c', 'user.name=T', '-c', 'user.email=t@e.com', 'commit', '-m', 'first'], empty);

    // The first commit is seeded away, not backfilled...
    expect(scanRepo(empty, cursors).events).toHaveLength(0);

    writeFileSync(join(empty, 'b.txt'), 'world', 'utf8');
    git(['add', '-A'], empty);
    git(['-c', 'user.name=T', '-c', 'user.email=t@e.com', 'commit', '-m', 'second'], empty);

    // ...and everything after it counts normally.
    expect(scanRepo(empty, cursors).events).toHaveLength(1);

    rmSync(empty, { recursive: true, force: true });
  });

  it('resyncs instead of replaying when the cursor commit is gone', () => {
    const cursors: CursorFile = { [repo]: { lastSha: 'f'.repeat(40), lastScan: '' } };
    const result = scanRepo(repo, cursors);
    expect(result.events).toHaveLength(0);
    expect(cursors[repo]?.lastSha).toBe(headSha(repo));
  });

  it('returns nothing for a directory that is not a repo', () => {
    const plain = tempDir('familiar-plain-');
    expect(scanRepo(plain, {}).events).toHaveLength(0);
    rmSync(plain, { recursive: true, force: true });
  });
});

describe('seeding helpers', () => {
  it('returns commit dates without producing events', () => {
    commit('src/x.ts', 'x');
    const dates = commitDatesSince(repo, 3650);
    expect(dates.length).toBeGreaterThan(0);
    for (const d of dates) expect(Number.isNaN(d.getTime())).toBe(false);
  });

  it('returns nothing for a non-repo', () => {
    const plain = tempDir('familiar-plain-');
    expect(commitDatesSince(plain, 60)).toEqual([]);
    rmSync(plain, { recursive: true, force: true });
  });

  it('discovers repos one level down and ignores plain folders', () => {
    const parent = tempDir('familiar-parent-');
    const inner = join(parent, 'proj');
    mkdirSync(join(parent, 'not-a-repo'), { recursive: true });
    mkdirSync(inner, { recursive: true });
    git(['init', '-q'], inner);

    const found = discoverRepos([parent]).map((p) => p.toLowerCase());
    expect(found.some((p) => p.endsWith('proj'))).toBe(true);
    expect(found.some((p) => p.endsWith('not-a-repo'))).toBe(false);

    rmSync(parent, { recursive: true, force: true });
  });

  it('tolerates roots that do not exist', () => {
    expect(() => discoverRepos([join(repo, 'missing')])).not.toThrow();
  });
});

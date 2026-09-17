import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  commitDatesSince,
  discoverRepos,
  findRepoRoot,
  headSha,
  looksLikeTestFile,
  scanAll,
  scanRepo,
} from '../src/adapters/git.js';
import { readCursors, writeCursors, type CursorFile } from '../src/state/config.js';
import { readEvents } from '../src/state/log.js';
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

/**
 * Runs git as somebody else. The environment has to change, not just `-c`:
 * GIT_AUTHOR_EMAIL in `git()` outranks config, so `-c user.email=` alone would
 * silently still author the commit as the repo's own identity.
 */
function gitAs(email: string, args: string[], cwd = repo): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Someone',
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: 'Someone',
      GIT_COMMITTER_EMAIL: email,
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

  // A shared repo is mostly other people's work. Counting it would make the
  // XP bar a measure of the team, which is the one thing it claims not to be.
  it('counts only commits made by the identity configured for the repo', () => {
    const cursors: CursorFile = {};
    scanRepo(repo, cursors);

    commit('src/mine.ts', 'my work');
    gitAs('teammate@example.com', ['commit', '--allow-empty', '-m', 'their work']);

    const events = scanRepo(repo, cursors).events;
    expect(events).toHaveLength(1);
    expect(events[0]?.meta.sha).toBe(git(['rev-parse', 'HEAD~1']).trim());
  });

  it('matches the identity regardless of letter case', () => {
    const cursors: CursorFile = {};
    scanRepo(repo, cursors);
    gitAs('Test@Example.COM', ['commit', '--allow-empty', '-m', 'shouty']);
    expect(scanRepo(repo, cursors).events).toHaveLength(1);
  });

  // The merge button is usually pressed by one person. Crediting the merger
  // made pr_merged — the biggest outcome there is — unreachable for everybody
  // else on the team, including for the PRs they wrote.
  it('credits a merged pull request to whoever wrote it, not whoever merged it', () => {
    const cursors: CursorFile = {};
    scanRepo(repo, cursors);

    git(['checkout', '-q', '-b', 'feature']);
    commit('src/mine.ts', 'my feature');
    git(['checkout', '-q', 'main']);
    gitAs('lead@example.com', ['merge', '--no-ff', '-m', 'Merge pull request #9 from me/feature', 'feature']);

    const events = scanRepo(repo, cursors).events;
    expect(events.filter((e) => e.type === 'pr_merged')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'commit')).toHaveLength(1);
  });

  it('does not credit you for merging a pull request somebody else wrote', () => {
    const cursors: CursorFile = {};
    scanRepo(repo, cursors);

    git(['checkout', '-q', '-b', 'feature']);
    gitAs('teammate@example.com', ['commit', '--allow-empty', '-m', 'their feature']);
    git(['checkout', '-q', 'main']);
    git(['merge', '--no-ff', '-m', 'Merge pull request #11 from them/feature', 'feature']);

    expect(scanRepo(repo, cursors).events).toHaveLength(0);
  });

  it('credits a shared pull request to whoever wrote most of it', () => {
    const cursors: CursorFile = {};
    scanRepo(repo, cursors);

    git(['checkout', '-q', '-b', 'feature']);
    commit('src/a.ts', 'mine one');
    commit('src/b.ts', 'mine two');
    gitAs('teammate@example.com', ['commit', '--allow-empty', '-m', 'their touch-up']);
    git(['checkout', '-q', 'main']);
    gitAs('lead@example.com', ['merge', '--no-ff', '-m', 'Merge pull request #12 from us/feature', 'feature']);

    const merged = scanRepo(repo, cursors).events.filter((e) => e.type === 'pr_merged');
    expect(merged).toHaveLength(1);
  });

  // "Merge branch 'develop' into feature" is keeping a branch current. The work
  // it brings in is already counted commit by commit, so the merge itself is
  // activity — scoring it as a commit paid 5 XP for pressing sync.
  it('does not score a merge that is not a pull request', () => {
    const cursors: CursorFile = {};
    scanRepo(repo, cursors);

    git(['checkout', '-q', '-b', 'feature']);
    commit('src/feature.ts', 'feature work');
    git(['checkout', '-q', 'main']);
    commit('src/main.ts', 'main moved on');
    git(['checkout', '-q', 'feature']);
    git(['merge', '--no-ff', '-m', "Merge branch 'main' into feature", 'main']);

    const events = scanRepo(repo, cursors).events;
    expect(events.every((e) => !String(e.meta.sha).startsWith(git(['rev-parse', 'HEAD']).trim()))).toBe(true);
    expect(events.filter((e) => e.type === 'commit')).toHaveLength(2);
    expect(events.filter((e) => e.type === 'pr_merged')).toHaveLength(0);
  });

  // GitHub's web buttons can sign with a different address than local commits.
  // .mailmap is git's own answer to "these addresses are the same person".
  it('honours .mailmap when deciding whose commit it is', () => {
    const cursors: CursorFile = {};
    writeFileSync(join(repo, '.mailmap'), 'Test <test@example.com> <web@example.com>' + String.fromCharCode(10), 'utf8');
    git(['add', '.mailmap']);
    git(['commit', '-m', 'mailmap']);
    scanRepo(repo, cursors);

    gitAs('web@example.com', ['commit', '--allow-empty', '-m', 'from the web']);
    expect(scanRepo(repo, cursors).events).toHaveLength(1);
  });

  // .mailmap rewrites authors to a canonical address. Comparing that against
  // the raw user.email would make every one of your own commits stop matching
  // the moment a repo maps your address somewhere else.
  it('maps your own address through .mailmap too', () => {
    const cursors: CursorFile = {};
    writeFileSync(join(repo, '.mailmap'), 'Test <me@personal.dev> <test@example.com>' + String.fromCharCode(10), 'utf8');
    git(['add', '.mailmap']);
    git(['commit', '-m', 'mailmap']);
    scanRepo(repo, cursors);

    commit('src/mine.ts', 'still mine');
    expect(scanRepo(repo, cursors).events).toHaveLength(1);
  });

  // Attribution used to cost one git call per merged PR, ~100 ms each on
  // Windows — a real 90-day backlog took 18 s against a 10 s hook timeout.
  it('attributes a merged pull request that pulled in several branches', () => {
    const cursors: CursorFile = {};
    scanRepo(repo, cursors);

    git(['checkout', '-q', '-b', 'feature']);
    commit('src/one.ts', 'mine one');
    git(['checkout', '-q', 'main']);
    gitAs('teammate@example.com', ['commit', '--allow-empty', '-m', 'main moved']);
    git(['checkout', '-q', 'feature']);
    // A sync merge inside the PR: its first-parent side is the branch, and the
    // commits it pulls in from main must not count as the PR's authors.
    git(['merge', '--no-ff', '-m', "Merge branch 'main' into feature", 'main']);
    commit('src/two.ts', 'mine two');
    git(['checkout', '-q', 'main']);
    gitAs('lead@example.com', ['merge', '--no-ff', '-m', 'Merge pull request #21 from me/feature', 'feature']);

    const events = scanRepo(repo, cursors).events;
    expect(events.filter((e) => e.type === 'pr_merged')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'commit')).toHaveLength(2);
  });

  it('does not count a pull request somebody else merged', () => {
    const cursors: CursorFile = {};
    scanRepo(repo, cursors);

    git(['checkout', '-q', '-b', 'feature']);
    gitAs('teammate@example.com', ['commit', '--allow-empty', '-m', 'their feature']);
    git(['checkout', '-q', 'main']);
    gitAs('teammate@example.com', ['merge', '--no-ff', '-m', 'Merge pull request #7 from them/feature', 'feature']);

    expect(scanRepo(repo, cursors).events).toHaveLength(0);
  });

  it('still moves the cursor past commits it did not count', () => {
    const cursors: CursorFile = {};
    scanRepo(repo, cursors);
    gitAs('teammate@example.com', ['commit', '--allow-empty', '-m', 'theirs']);
    scanRepo(repo, cursors);
    expect(cursors[repo]?.lastSha).toBe(headSha(repo));
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
    git(['config', 'user.email', 'test@example.com'], empty);
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

describe('scanAll', () => {
  let second: string;

  beforeEach(() => {
    second = tempDir('familiar-second-');
    git(['init', '-q', '-b', 'main'], second);
    git(['config', 'user.email', 'test@example.com'], second);
    git(['commit', '--allow-empty', '-m', 'initial'], second);
    const cursors = readCursors();
    scanRepo(repo, cursors);
    scanRepo(second, cursors);
    writeCursors(cursors);
    commit('src/a.ts', 'in the first repo');
    git(['commit', '--allow-empty', '-m', 'in the second repo'], second);
  });

  afterEach(() => {
    rmSync(second, { recursive: true, force: true });
  });

  it('writes the events it found and returns exactly those', () => {
    const written = scanAll(repo);
    expect(written).toHaveLength(2);
    expect(readEvents().map((e) => e.key).sort()).toEqual(written.map((e) => e.key).sort());
  });

  // A hook that runs past its timeout is killed. If position were only saved
  // at the end, every later hook would restart the same backlog and be killed
  // again — git XP would stop for good, silently.
  it('keeps the progress of every repo it finished, even if stopped early', () => {
    const first = scanAll(repo, { budgetMs: 0 });
    expect(first).toHaveLength(1);
    expect(readEvents()).toHaveLength(1);

    const rest = scanAll(repo, { budgetMs: 0 });
    expect(rest).toHaveLength(1);
    expect(readEvents()).toHaveLength(2);

    expect(scanAll(repo, { budgetMs: 0 })).toHaveLength(0);
  });

  it('records the events before it moves past them', () => {
    // Moving the cursor first would lose them for good if the process died
    // in between; writing first only risks a rescan, which dedupes.
    scanAll(repo, { budgetMs: 0 });
    const cursors = readCursors();
    const scanned = [repo, second].filter((r) => cursors[r]?.lastSha === headSha(r));
    expect(scanned).toHaveLength(1);
    expect(readEvents()).toHaveLength(1);
  });
});

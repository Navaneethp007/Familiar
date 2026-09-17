/**
 * The git adapter — the universal one.
 *
 * Commits happen whatever tool you use, so this is what gives every user a
 * familiar even with zero AI integration. It reads **local git only**: no
 * GitHub API, no network, no credentials. That is why private-repo work counts
 * and why nothing leaves the machine.
 *
 * It runs opportunistically on nearly every invocation, so two things are
 * non-negotiable: it must be cheap (incremental via cursors) and it must be
 * idempotent (events key on commit SHA).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { makeEvent, type FamiliarEvent } from '../core/events.js';
import { readCursors, registerRepo, writeCursors, type CursorFile } from '../state/config.js';
import { appendEvents } from '../state/log.js';
import { normaliseRepoPath } from './terminal.js';

const GIT_TIMEOUT_MS = 5_000;
/** Safety valve: a repo with a huge backlog should not produce a huge burst. */
const MAX_COMMITS_PER_SCAN = 500;

const FIELD = '\x1f';
const COMMIT_MARKER = '__FAMILIAR_COMMIT__';

const TEST_PATH = /(^|\/)(tests?|spec|__tests__)\//i;
const TEST_FILE = /\.(test|spec)\.[a-z0-9]+$/i;

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    // Not a repo, git missing, hung, or a bad range. All mean "no new events".
    return null;
  }
}

/** Absolute repo root for a directory, or null if it is not inside a repo. */
export function findRepoRoot(cwd: string): string | null {
  if (!existsSync(cwd)) return null;
  const out = git(['rev-parse', '--show-toplevel'], cwd);
  if (!out) return null;
  const path = out.trim();
  return path.length > 0 ? resolve(path) : null;
}

export function headSha(repoPath: string): string | null {
  const out = git(['rev-parse', 'HEAD'], repoPath);
  const sha = out?.trim();
  return sha && sha.length > 0 ? sha : null;
}

export function looksLikeTestFile(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return TEST_PATH.test(normalized) || TEST_FILE.test(normalized);
}

interface ParsedCommit {
  sha: string;
  isoDate: string;
  parents: string[];
  authorEmail: string;
  subject: string;
  files: string[];
}

function parseLog(raw: string): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  let current: ParsedCommit | null = null;

  for (const line of raw.split('\n')) {
    if (line.startsWith(COMMIT_MARKER)) {
      if (current) commits.push(current);
      const [sha = '', isoDate = '', parents = '', authorEmail = '', ...rest] = line
        .slice(COMMIT_MARKER.length)
        .split(FIELD);
      current = {
        sha,
        isoDate,
        parents: parents.split(' ').filter(Boolean),
        authorEmail,
        // Subjects can legitimately contain the separator; rejoin defensively.
        subject: rest.join(FIELD),
        files: [],
      };
      continue;
    }
    const trimmed = line.trim();
    if (current && trimmed.length > 0) current.files.push(trimmed);
  }
  if (current) commits.push(current);

  // git log is newest-first; the engine wants chronological order.
  return commits.reverse();
}

const PR_SUBJECT = [/Merge pull request #(\d+)/i, /\(#(\d+)\)\s*$/];

function prNumberFrom(subject: string): number | null {
  for (const pattern of PR_SUBJECT) {
    const match = pattern.exec(subject);
    if (match?.[1]) return Number.parseInt(match[1], 10);
  }
  return null;
}

/**
 * Whether a commit should score for this user at all.
 *
 * A shared repo is mostly other people's commits, and pulling them in used to
 * score them — in a real log, three quarters of the commits and nearly every
 * merge belonged to teammates. That made the XP bar a measure of the team,
 * which is the thing the whole project says it is not.
 *
 * Identity is the repo's own `user.email`, which git resolves through local
 * then global config. With none configured there is nothing to compare
 * against, and every authored commit counts, as it always did.
 *
 * Merges are judged differently, because who pressed merge is not who did the
 * work:
 *
 * - **A merge that is not a pull request** ("Merge branch 'develop' into
 *   feature") scores nothing for anyone. It keeps a branch current; the work it
 *   brings in is already counted commit by commit, so scoring the merge too
 *   paid 5 XP for pressing sync.
 * - **A merged pull request** belongs to whoever wrote most of it. On most
 *   teams one person presses the button, and crediting them made pr_merged —
 *   the biggest outcome in the table — unreachable for everybody else: in two
 *   real repos, 60 of 62 PRs one developer wrote scored nothing.
 */
function counts(
  commit: ParsedCommit,
  identity: string | undefined,
  bySha: ReadonlyMap<string, ParsedCommit>,
): boolean {
  if (commit.parents.length > 1) {
    if (prNumberFrom(commit.subject) === null) return false;
    return identity === undefined || pullRequestIsYours(commit, identity, bySha);
  }
  return identity === undefined || sameAuthor(commit.authorEmail, identity);
}

function sameAuthor(email: string, identity: string): boolean {
  return email.trim().toLowerCase() === identity;
}

/** Every commit in the scanned range reachable from `start`, `start` included. */
function reachable(start: string | undefined, bySha: ReadonlyMap<string, ParsedCommit>): Set<string> {
  const seen = new Set<string>();
  const stack = start ? [start] : [];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (seen.has(sha)) continue;
    const commit = bySha.get(sha);
    // Outside the range means reachable from the cursor, and everything behind
    // it is too — so stopping here loses nothing the range could contain.
    if (!commit) continue;
    seen.add(sha);
    stack.push(...commit.parents);
  }
  return seen;
}

/**
 * Whether you wrote at least half of what a merge brought in.
 *
 * What a merge brought in is `^1..^2`: reachable from its second parent but not
 * its first. That used to be a git call per PR merge — about 100 ms each on
 * Windows, which made a real 90-day backlog take 18 s against a hook that is
 * killed at 10. It is worked out here from the parent links the scan already
 * fetched instead, so a scan is one git call however many PRs it holds.
 *
 * Merges inside the branch are left out, for the reason `counts` gives. A branch
 * with no authored commits in range — merges only, or older than the scan can
 * see — has nobody to go by, so it falls back to whoever merged it. Exactly half
 * counts, so a pair's PR scores for both of them.
 */
function pullRequestIsYours(
  merge: ParsedCommit,
  identity: string,
  bySha: ReadonlyMap<string, ParsedCommit>,
): boolean {
  const mainline = reachable(merge.parents[0], bySha);
  const authors: string[] = [];
  for (const sha of reachable(merge.parents[1], bySha)) {
    const commit = bySha.get(sha);
    if (!commit || mainline.has(sha) || commit.parents.length > 1) continue;
    authors.push(commit.authorEmail);
  }
  if (authors.length === 0) return sameAuthor(merge.authorEmail, identity);
  const yours = authors.filter((email) => sameAuthor(email, identity)).length;
  return yours * 2 >= authors.length;
}

/**
 * Your address, as `.mailmap` would rewrite it.
 *
 * Authors are read through .mailmap (%aE), so the address they are compared to
 * has to go through it as well. Otherwise a repo that maps your address to
 * another one turns every commit you make into somebody else's.
 */
function yourIdentity(repoPath: string): string | undefined {
  const email = configuredEmail(repoPath);
  if (!email) return undefined;
  const mapped = git(['check-mailmap', `<${email}>`], repoPath);
  const canonical = mapped ? /<([^>]*)>\s*$/.exec(mapped.trim())?.[1] : undefined;
  return (canonical && canonical.length > 0 ? canonical : email).toLowerCase();
}

function toEvent(commit: ParsedCommit, rawRepoPath: string): FamiliarEvent {
  // Same shape the terminal and Claude adapters use, so a repo is one repo no
  // matter which tool observed the work happening in it.
  const repoPath = normaliseRepoPath(rawRepoPath);
  const repo = basename(repoPath);
  const when = new Date(commit.isoDate);
  const at = Number.isNaN(when.getTime()) ? new Date() : when;

  const isMerge = commit.parents.length > 1;
  const pr = prNumberFrom(commit.subject);

  // A merged PR is the biggest outcome there is, so a merge commit that names
  // a PR is reported as pr_merged rather than as an ordinary commit. Reporting
  // both would double-count the same piece of work.
  if (isMerge && pr !== null) {
    return makeEvent({
      type: 'pr_merged',
      source: 'git',
      key: `pr_merged:${repoPath}:${commit.sha}`,
      at,
      meta: { repo, repoPath, sha: commit.sha, pr, hour: at.getHours() },
    });
  }

  return makeEvent({
    type: 'commit',
    source: 'git',
    key: `commit:${repoPath}:${commit.sha}`,
    at,
    meta: {
      repo,
      repoPath,
      sha: commit.sha,
      hour: at.getHours(),
      touchedTests: commit.files.some(looksLikeTestFile),
      filesChanged: commit.files.length,
    },
  });
}

export interface ScanResult {
  events: FamiliarEvent[];
  /** True on a repo's very first scan, when history is skipped on purpose. */
  seeded: boolean;
}

/**
 * Scans one repo for commits since the last cursor.
 *
 * On a repo's **first** scan we record HEAD and emit nothing. This is the idea
 * doc's rule made concrete: history seeds personality, not level. Backfilling
 * XP from years of commits would hand you a maxed creature on day one and skip
 * the entire game.
 */
export function scanRepo(repoPath: string, cursors: CursorFile): ScanResult {
  const head = headSha(repoPath);
  if (!head) return { events: [], seeded: false };

  const cursor = cursors[repoPath];
  const now = new Date().toISOString();

  if (!cursor) {
    cursors[repoPath] = { lastSha: head, lastScan: now };
    return { events: [], seeded: true };
  }

  if (cursor.lastSha === head) {
    cursor.lastScan = now;
    return { events: [], seeded: false };
  }

  if (!cursor.lastSha) {
    // A cursor with no SHA means we have never successfully read this repo —
    // it had no commits yet, or git was unavailable when we first looked.
    // Treat this as a first scan. Falling through to `git log HEAD` would
    // replay the repo's entire history as XP, which is exactly the backfill
    // the design forbids.
    cursors[repoPath] = { lastSha: head, lastScan: now };
    return { events: [], seeded: true };
  }

  const range = `${cursor.lastSha}..HEAD`;
  const raw = git(
    [
      'log',
      range,
      `--max-count=${MAX_COMMITS_PER_SCAN}`,
      // Subject last: it is the only field that can contain the separator.
      // %aE, not %ae: the author as .mailmap resolves it, so an address used
      // by GitHub's web buttons can be mapped onto the one commits are made with.
      `--format=${COMMIT_MARKER}%H${FIELD}%aI${FIELD}%P${FIELD}%aE${FIELD}%s`,
      '--name-only',
    ],
    repoPath,
  );

  if (raw === null) {
    // Range invalid — usually a rebase or force-push rewrote the cursor commit
    // out of existence. Resync to HEAD rather than replaying rewritten history.
    cursors[repoPath] = { lastSha: head, lastScan: now };
    return { events: [], seeded: false };
  }

  const commits = parseLog(raw);
  // Only worth a git call once there is something to judge.
  const identity = commits.length > 0 ? yourIdentity(repoPath) : undefined;
  const bySha = new Map(commits.map((c) => [c.sha, c]));
  const events = commits.filter((c) => counts(c, identity, bySha)).map((c) => toEvent(c, repoPath));
  // The cursor moves past everything, counted or not — somebody else's commit
  // is not a backlog to come back to.
  cursors[repoPath] = { lastSha: head, lastScan: now };
  return { events, seeded: false };
}

export interface ScanAllOptions {
  /**
   * Stop starting new repos once this much time has passed. A repo already
   * under way always finishes. Unset means no limit.
   */
  budgetMs?: number;
}

/**
 * Scans every known repo plus, if `cwd` is inside one, that repo — registering
 * it on the way. This passive discovery is why there is no `familiar add-repo`:
 * working in a repo is how Familiar learns about it.
 *
 * **Writes what it finds**, repo by repo, and returns exactly the events it
 * wrote. The order inside each repo is the point: events first, then the
 * cursor. The hook that calls this is killed at its timeout, and position used
 * to be saved only after every repo — so a backlog longer than the timeout
 * restarted from scratch every time and git XP stopped for good, silently.
 * Saved per repo, a killed scan keeps what it finished. Saved *after* its
 * events, a scan killed in between only rescans commits it already wrote, and
 * those dedupe on their SHA; the other order would skip them for good.
 *
 * Least recently scanned repos go first, so a budget that keeps running out
 * cannot starve the same repos every time.
 */
export function scanAll(cwd = process.cwd(), options: ScanAllOptions = {}): FamiliarEvent[] {
  const startedAt = Date.now();
  const budget = options.budgetMs ?? Number.POSITIVE_INFINITY;
  const cursors = readCursors();
  const repos = new Set<string>();

  const here = findRepoRoot(cwd);
  if (here) {
    repos.add(here);
    registerRepo(here);
  }
  for (const repo of Object.keys(cursors)) repos.add(repo);

  const lastScanned = (repo: string): number => {
    const at = Date.parse(cursors[repo]?.lastScan ?? '');
    return Number.isNaN(at) ? Number.NEGATIVE_INFINITY : at;
  };
  const queue = [...repos].sort((a, b) => lastScanned(a) - lastScanned(b));

  const written: FamiliarEvent[] = [];
  let scanned = 0;
  for (const repo of queue) {
    if (scanned > 0 && Date.now() - startedAt >= budget) break;
    if (!existsSync(repo)) continue;
    written.push(...appendEvents(scanRepo(repo, cursors).events));
    writeCursors(cursors);
    scanned++;
  }

  return written;
}

// --- seeding ---------------------------------------------------------------

/**
 * Commit timestamps in a window, for species selection only. Deliberately
 * returns dates and nothing else — there is no path from here to XP.
 */
export function commitDatesSince(repoPath: string, days: number, author?: string): Date[] {
  const args = ['log', `--since=${days}.days.ago`, '--format=%aI', '--max-count=2000'];
  if (author) args.push(`--author=${author}`);
  const raw = git(args, repoPath);
  if (!raw) return [];

  const dates: Date[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const d = new Date(trimmed);
    if (!Number.isNaN(d.getTime())) dates.push(d);
  }
  return dates;
}

export function configuredEmail(cwd: string): string | undefined {
  const out = git(['config', 'user.email'], cwd);
  const email = out?.trim();
  return email && email.length > 0 ? email : undefined;
}

/**
 * Finds git repos to seed from: the current one, plus one level down from the
 * given roots. Shallow on purpose — deep-scanning every directory on the disk
 * is slow, noisy, and feels invasive for a toy.
 */
export function discoverRepos(roots: readonly string[], limit = 60): string[] {
  const found = new Set<string>();

  for (const root of roots) {
    if (found.size >= limit) break;
    if (!existsSync(root)) continue;

    if (existsSync(join(root, '.git'))) found.add(resolve(root));

    let entries: string[] = [];
    try {
      entries = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name);
    } catch {
      continue;
    }

    for (const name of entries) {
      if (found.size >= limit) break;
      const candidate = join(root, name);
      if (existsSync(join(candidate, '.git'))) found.add(resolve(candidate));
    }
  }

  return [...found];
}

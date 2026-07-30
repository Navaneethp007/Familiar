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
  subject: string;
  files: string[];
}

function parseLog(raw: string): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  let current: ParsedCommit | null = null;

  for (const line of raw.split('\n')) {
    if (line.startsWith(COMMIT_MARKER)) {
      if (current) commits.push(current);
      const [sha = '', isoDate = '', parents = '', ...rest] = line
        .slice(COMMIT_MARKER.length)
        .split(FIELD);
      current = {
        sha,
        isoDate,
        parents: parents.split(' ').filter(Boolean),
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
      `--format=${COMMIT_MARKER}%H${FIELD}%aI${FIELD}%P${FIELD}%s`,
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

  const events = parseLog(raw).map((c) => toEvent(c, repoPath));
  cursors[repoPath] = { lastSha: head, lastScan: now };
  return { events, seeded: false };
}

/**
 * Scans every known repo plus, if `cwd` is inside one, that repo — registering
 * it on the way. This passive discovery is why there is no `familiar add-repo`:
 * working in a repo is how Familiar learns about it.
 */
export function scanAll(cwd = process.cwd()): FamiliarEvent[] {
  const cursors = readCursors();
  const repos = new Set<string>();

  const here = findRepoRoot(cwd);
  if (here) {
    repos.add(here);
    registerRepo(here);
  }

  for (const repo of Object.keys(cursors)) repos.add(repo);

  const events: FamiliarEvent[] = [];
  for (const repo of repos) {
    if (!existsSync(repo)) continue;
    events.push(...scanRepo(repo, cursors).events);
  }

  writeCursors(cursors);
  return events;
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

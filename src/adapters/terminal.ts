/**
 * The terminal adapter.
 *
 * Shell profiles append one line per check-shaped command to a spool file.
 * This drains that spool into the canonical event log.
 *
 * Why a spool rather than the shell calling Familiar directly: the shell hook
 * runs after every command you type, so it must cost nothing. Appending a line
 * with a builtin costs nothing; launching Node costs 60-100ms on every prompt,
 * which you would notice within a minute and uninstall within a day.
 *
 * The shell's pattern is deliberately coarse and dumb — it lives in your
 * profile, where it is hard to change and impossible to test. All real
 * classification happens here, where it is neither.
 *
 * Note what the shell does *not* log: everything else. Recording every command
 * would mean keeping a second copy of your shell history, including anything
 * secret you ever pasted onto a command line. Not for a toy.
 */

import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { basename } from 'node:path';

import type { CheckKind } from '../core/checks.js';
import { makeEvent, type FamiliarEvent } from '../core/events.js';
import { readCursors, writeCursors, type CursorFile } from '../state/config.js';
import { shellLogPath } from '../state/paths.js';

/** Key under which the spool's read offset is stored in cursor.json. */
export const SHELL_CURSOR_KEY = '__shell';

export interface SpoolLine {
  at: Date;
  exitCode: number;
  agent: 'claude-code' | 'cursor' | null;
  cwd: string;
  command: string;
  /** The original text, used to derive a content-stable dedupe key. */
  raw: string;
}

/** FNV-1a, matching the hash used for tone selection. */
function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * Parses one spool line. Returns null for anything malformed rather than
 * throwing — this file is written by shell code we cannot debug from here, so
 * it must be assumed to contain surprises.
 */
export function parseSpoolLine(raw: string): SpoolLine | null {
  const trimmed = raw.replace(/\r$/, '');
  if (trimmed.trim().length === 0) return null;

  const parts = trimmed.split('\t');
  if (parts.length < 5) return null;

  const [rawAt, rawCode, rawAgent, rawCwd, ...rest] = parts;
  // The command is everything left, rejoined — a stray tab inside a command
  // should not silently truncate it.
  const command = rest.join('\t').trim();
  if (command.length === 0) return null;

  const ms = Number.parseInt(rawAt ?? '', 10);
  if (!Number.isFinite(ms) || ms <= 0) return null;

  const exitCode = Number.parseInt(rawCode ?? '', 10);
  if (!Number.isFinite(exitCode)) return null;

  const cwd = (rawCwd ?? '').trim();
  if (cwd.length === 0) return null;

  return {
    at: new Date(ms),
    exitCode,
    agent: rawAgent === 'claude-code' || rawAgent === 'cursor' ? rawAgent : null,
    cwd,
    command,
    raw: trimmed,
  };
}

// --- classification --------------------------------------------------------

/**
 * Ordered most specific first: `npm run typecheck` is a typecheck, not a
 * build, even though both mention npm.
 */
const KIND_PATTERNS: Array<[CheckKind, RegExp]> = [
  ['typecheck', /\b(typecheck|type-check|tsc\b|mypy|pyright|flow check)/i],
  ['lint', /\b(lint|eslint|ruff|clippy|rubocop|flake8|golangci-lint)/i],
  [
    'test',
    /\b(tests?\b|vitest|jest|mocha|pytest|rspec|phpunit|go\s+test|cargo\s+test|dotnet\s+test|unittest)/i,
  ],
  ['build', /\b(build|compile|bundle|cargo\s+(check|build)|go\s+build|dotnet\s+build|make\b)/i],
];

/**
 * Commands that never resolve to a verdict. A watcher runs forever, so its
 * exit code means "you pressed Ctrl-C", not "the tests failed" — recording
 * that as a red would manufacture fixes out of nothing.
 */
const NEVER_A_CHECK = /(--watch\b|\bwatch\b|:watch\b|--ui\b|-w\b|\bnodemon\b|--coverage-watch)/i;

export function classifyCommand(command: string): CheckKind | null {
  if (NEVER_A_CHECK.test(command)) return null;
  for (const [kind, pattern] of KIND_PATTERNS) {
    if (pattern.test(command)) return kind;
  }
  return null;
}

// --- spool line -> event ---------------------------------------------------

/**
 * Puts a path into the one shape every adapter agrees on.
 *
 * Git Bash reports the working directory as `/c/Users/you/repo` while git and
 * PowerShell say `C:/Users/you/repo`. Left alone those are different strings,
 * so a red logged in one shell would never pair with a green from the other,
 * and no fix would ever be detected across them.
 */
export function normaliseRepoPath(raw: string): string {
  let path = raw.replace(/\\/g, '/').replace(/\/+$/, '');
  const msys = /^\/([a-z])\/(.*)$/i.exec(path);
  if (msys) path = `${msys[1]!.toUpperCase()}:/${msys[2]}`;
  // Drive letters differ in case between tools too.
  return path.replace(/^([a-z]):/, (_, drive: string) => `${drive.toUpperCase()}:`);
}

export function eventFromSpoolLine(line: SpoolLine): FamiliarEvent | null {
  const kind = classifyCommand(line.command);
  if (kind === null) return null;

  const repoPath = normaliseRepoPath(line.cwd);

  return makeEvent({
    type: line.exitCode === 0 ? 'check_passed' : 'check_failed',
    source: 'terminal',
    // Content-derived, so re-reading the spool from offset zero produces
    // identical keys and the log discards them.
    key: `check:${hash(line.raw)}`,
    at: line.at,
    meta: {
      kind,
      repoPath,
      repo: basename(repoPath) || repoPath,
      agent: line.agent,
      command: line.command,
      exitCode: line.exitCode,
    },
  });
}

export function eventsFromSpool(text: string): FamiliarEvent[] {
  const events: FamiliarEvent[] = [];
  for (const raw of text.split('\n')) {
    const line = parseSpoolLine(raw);
    if (!line) continue;
    const event = eventFromSpoolLine(line);
    if (event) events.push(event);
  }
  return events;
}

// --- draining --------------------------------------------------------------

export interface DrainResult {
  events: FamiliarEvent[];
  /** True when the spool shrank and we restarted from the beginning. */
  reset: boolean;
}

function readFrom(path: string, offset: number, length: number): string {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const read = readSync(fd, buffer, 0, length, offset);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Reads whatever the shell has appended since last time.
 *
 * The spool is never rewritten or truncated by us — a shell could be appending
 * at any moment, and a read-modify-write would lose it. We only ever move a
 * byte offset forward.
 *
 * If the file has shrunk, someone deleted or rotated it, so we start over.
 * That is safe precisely because keys are content-derived: re-ingested lines
 * collide with what is already in the log and get dropped.
 */
export function drainSpool(cursors: CursorFile, path = shellLogPath()): DrainResult {
  if (!existsSync(path)) return { events: [], reset: false };

  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return { events: [], reset: false };
  }

  const previous = cursors[SHELL_CURSOR_KEY];
  let offset = 0;
  let reset = false;

  if (previous?.lastSha) {
    const parsed = Number.parseInt(previous.lastSha, 10);
    if (Number.isFinite(parsed) && parsed >= 0) offset = parsed;
  }

  if (offset > size) {
    offset = 0;
    reset = true;
  }
  if (offset === size) {
    cursors[SHELL_CURSOR_KEY] = { lastSha: String(size), lastScan: new Date().toISOString() };
    return { events: [], reset };
  }

  let text: string;
  try {
    text = readFrom(path, offset, size - offset);
  } catch {
    return { events: [], reset };
  }

  // Stop at the last newline: anything after it is a line still being written.
  // It will be picked up next time, whole.
  const lastNewline = text.lastIndexOf('\n');
  const complete = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : '';
  const consumed = Buffer.byteLength(complete, 'utf8');

  cursors[SHELL_CURSOR_KEY] = {
    lastSha: String(offset + consumed),
    lastScan: new Date().toISOString(),
  };

  return { events: eventsFromSpool(complete), reset };
}

/** Convenience wrapper that loads and persists the cursor file itself. */
export function drainShellLog(path = shellLogPath()): FamiliarEvent[] {
  const cursors = readCursors();
  const result = drainSpool(cursors, path);
  writeCursors(cursors);
  return result.events;
}

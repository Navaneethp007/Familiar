/**
 * The one internal event format. Every adapter translates its tool's signals
 * into these, and nothing downstream knows or cares where an event came from.
 */

export const EVENT_TYPES = [
  'session_start',
  'tool_used',
  'commit',
  'pr_merged',
  // Check observations. Both are worth 0 XP on their own — the reward comes
  // from a red->green transition, which only the engine can see. See checks.ts.
  'check_passed',
  'check_failed',
  // Superseded by check_passed / check_failed, kept so logs written by earlier
  // versions still read correctly. Treated as test-kind observations.
  'tests_passed',
  'tests_failed',
] as const;

/**
 * The rule this list follows, stated once so it cannot be read two ways.
 *
 * **A type that has ever been written to a log is permanent.** `isEventType`
 * gates what `readEvents` will accept, so dropping a member silently discards
 * those lines: XP disappears and a level can go backwards. That is why
 * `tests_passed` / `tests_failed` remain above long after nothing emits them.
 *
 * A type that was never emitted by any adapter is a different thing — it is
 * vocabulary that was declared and never used, and removing it costs nobody
 * anything. `pr_opened` was exactly that: scored at 15 XP, given lines in all
 * four tone banks, and unreachable, because knowing a PR was opened needs a
 * forge API and nothing here touches the network. Verified before removing it
 * that no adapter had ever produced one, in any revision.
 *
 * So: append freely, remove only what provably never existed on disk.
 */

export type EventType = (typeof EVENT_TYPES)[number];

export type EventSource = 'git' | 'claude-code' | 'terminal' | 'manual';

export interface EventMeta {
  /** Repo folder name, for display. */
  repo?: string;
  /** Absolute repo path, for grouping. */
  repoPath?: string;
  sha?: string;
  /** Local hour 0-23 the event happened. Night-owl scoring reads this. */
  hour?: number;
  /** Commit touched a test file. Test-guardian scoring reads this. */
  touchedTests?: boolean;
  filesChanged?: number;
  /** PR number, when derived from a local merge commit. */
  pr?: number;
  /** The command that produced a tests_passed / tests_failed. */
  command?: string;
  /** Claude Code tool name for tool_used. */
  tool?: string;
  [key: string]: unknown;
}

export interface FamiliarEvent {
  /** ISO-8601 UTC timestamp. */
  t: string;
  type: EventType;
  source: EventSource;
  /**
   * Natural dedupe key. Two events with the same key are the same occurrence,
   * however many times an adapter re-reports it. Commits key on SHA, which is
   * what makes the git adapter safe to run on every single invocation.
   */
  key: string;
  meta: EventMeta;
}

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && EVENT_TYPE_SET.has(value);
}

/**
 * Structural validation for a line read off disk. Deliberately permissive about
 * `meta` and `source` (forward-compatible with events written by a newer
 * version) and strict about the four fields the engine actually depends on.
 */
export function isFamiliarEvent(value: unknown): value is FamiliarEvent {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  if (typeof e['t'] !== 'string' || Number.isNaN(Date.parse(e['t']))) return false;
  if (!isEventType(e['type'])) return false;
  if (typeof e['key'] !== 'string' || e['key'].length === 0) return false;
  if (typeof e['source'] !== 'string') return false;
  if (e['meta'] !== undefined && (typeof e['meta'] !== 'object' || e['meta'] === null)) return false;
  return true;
}

export interface MakeEventInput {
  type: EventType;
  source: EventSource;
  key: string;
  at?: Date | string;
  meta?: EventMeta;
}

export function makeEvent(input: MakeEventInput): FamiliarEvent {
  const when =
    input.at instanceof Date
      ? input.at
      : typeof input.at === 'string'
        ? new Date(input.at)
        : new Date();

  const meta: EventMeta = { ...(input.meta ?? {}) };
  if (meta.hour === undefined) meta.hour = when.getHours();

  return { t: when.toISOString(), type: input.type, source: input.source, key: input.key, meta };
}

/**
 * Drops repeats by key, keeping the first occurrence. Order is preserved so the
 * reducer still sees a chronological stream.
 */
export function dedupeEvents(events: readonly FamiliarEvent[]): FamiliarEvent[] {
  const seen = new Set<string>();
  const out: FamiliarEvent[] = [];
  for (const e of events) {
    if (seen.has(e.key)) continue;
    seen.add(e.key);
    out.push(e);
  }
  return out;
}

export function sortEvents(events: readonly FamiliarEvent[]): FamiliarEvent[] {
  return [...events].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

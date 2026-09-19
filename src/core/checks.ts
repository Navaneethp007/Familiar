/**
 * Check transitions — where "an outcome is a change of state, not a repeated
 * observation" is actually enforced.
 *
 * Adapters report facts: this check passed, that one failed. They never report
 * "a fix happened", because a fix is not observable from a single command. It
 * only exists relative to what came before, so it is derived here.
 *
 * That split matters for two reasons:
 *
 * 1. **It closes the repetition exploit.** A flat reward per green run means
 *    twenty test runs during one debugging session out-earn five merged PRs,
 *    for tests that were already passing. Green after green is not an outcome.
 * 2. **It keeps rewards retunable.** Nothing is stored, so changing the fix
 *    reward re-scores every past transition on the next read.
 *
 * Both `xp.ts` and `habits.ts` fold through here, so XP and branch selection
 * can never disagree about what counts as a fix.
 */

import type { FamiliarEvent } from './events.js';

export const CHECK_KINDS = ['test', 'build', 'typecheck', 'lint'] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export const CHECK_KIND_LABELS: Record<CheckKind, string> = {
  test: 'tests',
  build: 'build',
  typecheck: 'typecheck',
  lint: 'lint',
};

/** Which agent, if any, ran the command. */
export type Agent = 'claude-code' | 'cursor' | null;

// --- reward shape ----------------------------------------------------------

/** A red older than this is no longer something you are actively fixing. */
export const STALE_RED_MS = 24 * 60 * 60 * 1000;

export const FIX_BASE_XP = 20;
export const FIX_PER_ATTEMPT_XP = 5;
export const FIX_MAX_BONUS_ATTEMPTS = 3;
/** First time a check has ever passed here. A small, real win. */
export const FIRST_GREEN_XP = 3;

/**
 * Grinding at something for four attempts is a harder-won fix than getting it
 * first try, and the log is the only place that difference is visible. Capped,
 * because past a point more attempts means stuck, not heroic.
 */
export function fixXp(attempts: number): number {
  const extra = Math.min(Math.max(attempts - 1, 0), FIX_MAX_BONUS_ATTEMPTS);
  return FIX_BASE_XP + extra * FIX_PER_ATTEMPT_XP;
}

// --- reading observations off events ---------------------------------------

export interface CheckObservation {
  passed: boolean;
  kind: CheckKind;
  repoPath: string;
  agent: Agent;
  at: number;
  eventKey: string;
}

function normaliseKind(value: unknown): CheckKind {
  return (CHECK_KINDS as readonly string[]).includes(value as string)
    ? (value as CheckKind)
    : 'test';
}

function normaliseAgent(value: unknown): Agent {
  return value === 'claude-code' || value === 'cursor' ? value : null;
}

/**
 * Reads an event as a check observation, or returns null if it isn't one.
 *
 * `tests_passed` / `tests_failed` are still honoured as test-kind observations
 * so logs written by the previous version keep working. Their old flat reward
 * is gone, so replaying an old log re-scores it downward — which is the
 * intended consequence of deriving state rather than storing it.
 */
export function asObservation(event: FamiliarEvent): CheckObservation | null {
  let passed: boolean;
  switch (event.type) {
    case 'check_passed':
    case 'tests_passed':
      passed = true;
      break;
    case 'check_failed':
    case 'tests_failed':
      passed = false;
      break;
    default:
      return null;
  }

  const repoPath = typeof event.meta.repoPath === 'string' ? event.meta.repoPath : '(unknown)';

  return {
    passed,
    kind: normaliseKind(event.meta['kind']),
    repoPath,
    agent: normaliseAgent(event.meta['agent']),
    at: Date.parse(event.t),
    eventKey: event.key,
  };
}

// --- the fold --------------------------------------------------------------

export interface FixRecord {
  kind: CheckKind;
  repoPath: string;
  agent: Agent;
  /** Consecutive failures immediately before this green. Always >= 1. */
  attempts: number;
  at: number;
  eventKey: string;
  xp: number;
}

/**
 * A slot's first green, reached *cold* — with no live prior status.
 *
 * Read the qualifier carefully, because two near-misses are excluded:
 *
 * - Not `firstGreens`, which counts every green with no live prior status and
 *   so recurs after each 24-hour gap. This fires once per slot, ever.
 * - Not "the first time a slot was green" either. A red fixed inside the
 *   staleness window takes the fix branch, which records nothing here but still
 *   marks the slot green — so a slot whose first green arrived *as a fix* can
 *   never produce one of these, at any later point.
 *
 * That exclusion is the point rather than an oversight: a fix already gets its
 * own line from `check_fixed` and friends, and announcing it twice would read
 * as the familiar not paying attention.
 */
export interface ColdGreenRecord {
  kind: CheckKind;
  repoPath: string;
  agent: Agent;
  at: number;
  eventKey: string;
}

/**
 * A green reached with no live prior status — what `firstGreens` counts.
 *
 * Recorded rather than merely tallied so that a *window* can be taken over the
 * transitions a whole-log fold produced. Folding a sliced log instead would
 * reclassify a green whose red fell outside the slice as a first green, moving
 * score from firefighter straight to one_shot — the two are exact complements
 * on their share term in habits.ts.
 *
 * Not the same thing as ColdGreenRecord, which fires once per slot ever and is
 * therefore a lossy subset of these. See the note there.
 */
export interface FirstGreenRecord {
  kind: CheckKind;
  repoPath: string;
  agent: Agent;
  at: number;
  eventKey: string;
}

export interface CheckFoldResult {
  /**
   * XP earned *at* a given event. Returned per-event rather than as a total so
   * the caller can keep awarding in chronological order and still detect
   * exactly which event triggered a level-up.
   */
  xpByEventKey: Map<string, number>;
  fixes: FixRecord[];
  /** One per clean first pass, in log order. `firstGreens` is its length. */
  firstGreenRecords: FirstGreenRecord[];
  /** Checks that passed with no prior red — clean first passes. */
  firstGreens: number;
  /** One entry per slot that first went green cold. Never scored. */
  coldGreenRecords: ColdGreenRecord[];
  /** Total failing observations. Never scored; drives mood and tone. */
  failures: number;
  /** Passes that changed nothing, i.e. the repetition that used to pay out. */
  redundantGreens: number;
}

interface Status {
  green: boolean;
  at: number;
  /** Consecutive failures so far in the current red streak. */
  attempts: number;
}

/**
 * Folds observations into transitions.
 *
 * Status is tracked per (repo, kind) rather than per command, because narrowing
 * `npm test` down to a single failing file is the normal way to debug — keying
 * on the exact command string would miss nearly every real fix.
 */
export function foldChecks(events: readonly FamiliarEvent[]): CheckFoldResult {
  const status = new Map<string, Status>();
  const xpByEventKey = new Map<string, number>();
  const fixes: FixRecord[] = [];
  const coldGreenRecords: ColdGreenRecord[] = [];
  // Separate from `status` because that map is subject to staleness, and a slot
  // having gone quiet for a day does not make its next green the first one.
  // Tracks green rather than merely seen, so a suite that was red for a week and
  // finally passes after the red went stale still counts as never-green-before.
  // Note it is set on the fix path too, which is what stops a fix from being
  // announced a second time as a first green.
  const everGreen = new Set<string>();
  const firstGreenRecords: FirstGreenRecord[] = [];
  let failures = 0;
  let redundantGreens = 0;

  for (const event of events) {
    const obs = asObservation(event);
    if (!obs) continue;

    const slot = `${obs.repoPath}\u0000${obs.kind}`;
    const previous = status.get(slot);

    // Staleness is measured against the observation's own timestamp, not the
    // wall clock, so replaying a log always produces the same result.
    const stale =
      previous !== undefined && Number.isFinite(obs.at) && obs.at - previous.at > STALE_RED_MS;
    const known = previous !== undefined && !stale;

    if (!obs.passed) {
      failures++;
      const attempts = known && !previous.green ? previous.attempts + 1 : 1;
      status.set(slot, { green: false, at: obs.at, attempts });
      continue;
    }

    if (known && !previous.green) {
      const xp = fixXp(previous.attempts);
      xpByEventKey.set(obs.eventKey, xp);
      fixes.push({
        kind: obs.kind,
        repoPath: obs.repoPath,
        agent: obs.agent,
        attempts: previous.attempts,
        at: obs.at,
        eventKey: obs.eventKey,
        xp,
      });
    } else if (!known) {
      firstGreenRecords.push({
        kind: obs.kind,
        repoPath: obs.repoPath,
        agent: obs.agent,
        at: obs.at,
        eventKey: obs.eventKey,
      });
      xpByEventKey.set(obs.eventKey, FIRST_GREEN_XP);
      if (!everGreen.has(slot)) {
        coldGreenRecords.push({
          kind: obs.kind,
          repoPath: obs.repoPath,
          agent: obs.agent,
          at: obs.at,
          eventKey: obs.eventKey,
        });
      }
    } else {
      // Already green and still green. Nothing changed, so nothing is earned.
      redundantGreens++;
    }

    status.set(slot, { green: true, at: obs.at, attempts: 0 });
    // Reached by all three green outcomes, and never by a failure.
    everGreen.add(slot);
  }

  return {
    xpByEventKey,
    fixes,
    coldGreenRecords,
    firstGreenRecords,
    firstGreens: firstGreenRecords.length,
    failures,
    redundantGreens,
  };
}

// --- summaries used by branch scoring and the surfaces ---------------------

export interface CheckSummary {
  fixes: number;
  firstGreens: number;
  failures: number;
  fixesByKind: Record<CheckKind, number>;
  /** Fixes reached while an agent was running the command. */
  fixesWithAgent: number;
  /** Passes that changed nothing — the repetition that used to pay out. */
  redundantGreens: number;
  lastFix: FixRecord | null;
  /** Slots whose first green arrived cold, counted once each. See ColdGreenRecord. */
  coldFirstGreens: number;
  /** Most recent slot to go green cold for the first time. */
  lastColdGreen: ColdGreenRecord | null;
}

/**
 * The only check facts habit scoring reads. `CheckSummary` satisfies it
 * structurally, so every existing caller keeps working unchanged.
 */
export interface HabitCheckCounts {
  fixes: number;
  firstGreens: number;
  fixesByKind: Record<CheckKind, number>;
  fixesWithAgent: number;
}

/**
 * Habit counts restricted to the transitions triggered by `keys`.
 *
 * `result` MUST come from a fold over the whole log; this filters its output.
 * Folding a slice and summarising that is the bug this function exists to
 * avoid — see FirstGreenRecord.
 *
 * Membership is by event key rather than a timestamp cutoff on purpose: a git
 * scan routinely emits many commits inside the same second, so a `since`
 * boundary would have real ties exactly where precision matters.
 *
 * Deliberately narrower than CheckSummary. A windowed summary would have to lie
 * about `failures` and `redundantGreens`, which have no records to filter, and
 * about `lastFix`/`lastColdGreen`, which mean "most recent ever" to the hook.
 */
export function countChecksIn(
  result: CheckFoldResult,
  keys: ReadonlySet<string>,
): HabitCheckCounts {
  const fixesByKind: Record<CheckKind, number> = { test: 0, build: 0, typecheck: 0, lint: 0 };
  let fixes = 0;
  let fixesWithAgent = 0;

  for (const fix of result.fixes) {
    if (!keys.has(fix.eventKey)) continue;
    fixes++;
    fixesByKind[fix.kind]++;
    if (fix.agent !== null) fixesWithAgent++;
  }

  const firstGreens = result.firstGreenRecords.filter((r) => keys.has(r.eventKey)).length;
  return { fixes, firstGreens, fixesByKind, fixesWithAgent };
}

export function summariseChecks(result: CheckFoldResult): CheckSummary {
  const fixesByKind: Record<CheckKind, number> = { test: 0, build: 0, typecheck: 0, lint: 0 };
  let fixesWithAgent = 0;

  for (const fix of result.fixes) {
    fixesByKind[fix.kind]++;
    if (fix.agent !== null) fixesWithAgent++;
  }

  return {
    fixes: result.fixes.length,
    firstGreens: result.firstGreens,
    failures: result.failures,
    fixesByKind,
    fixesWithAgent,
    redundantGreens: result.redundantGreens,
    lastFix: result.fixes[result.fixes.length - 1] ?? null,
    coldFirstGreens: result.coldGreenRecords.length,
    lastColdGreen: result.coldGreenRecords[result.coldGreenRecords.length - 1] ?? null,
  };
}

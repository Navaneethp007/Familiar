/**
 * The second evolution — deciding that a familiar has become something else.
 *
 * A branch is chosen once, at EVOLVE_LEVEL, on whatever evidence existed by
 * then: a couple of weeks of work. It is then permanent. This module is the one
 * chance to revise that, late in a familiar's life, if the person's work has
 * genuinely changed.
 *
 * **It is decided on a window, and the window is not an optimisation.**
 * `saturate(value, halfway)` in habits.ts uses halfway points of 4, 6 and 8, so
 * once counts reach the hundreds every habit sits near 1.0 and the gaps between
 * them collapse. Measured on a real log: a 0.17 margin at the first evolution
 * had become 0.07 across all time. Scored over a whole life, the habits stop
 * being able to tell anything apart. A capped window keeps the counts in the
 * range where `saturate` still separates.
 *
 * **The one place this project does not derive.** The first evolution is a
 * *prefix* decision — replay the log and the same event crosses the same
 * threshold, scored on the same prefix, forever. This is a *suffix* decision:
 * the window slides with every new event, so replaying tomorrow would judge a
 * different span and could name a different branch. It is therefore observed
 * once, at the moment it becomes true, and stored (see state/identity.ts).
 * Everything here is pure; the caller decides whether to keep the answer.
 */

import { countChecksIn, foldChecks, type CheckFoldResult, type HabitCheckCounts } from './checks.js';
import { dedupeEvents, sortEvents, type FamiliarEvent } from './events.js';
import {
  CHECK_DEPENDENT_BRANCHES,
  scoreHabits,
  selectBranch,
  type Branch,
  type HabitScores,
} from './habits.js';

/**
 * The floor, with no ceiling above it.
 *
 * A floor, never a trigger: reaching it entitles nobody to anything, it only
 * stops this happening early. No ceiling because past MAX_LEVEL this is the one
 * real event a familiar has left — a creature can sit at the cap for a year and
 * then genuinely become something else, because the person did.
 */
export const REEVOLVE_LEVEL = 50;

/**
 * How far a challenger must beat the incumbent, in the same window.
 *
 * 0.07 is the measured noise floor — the all-time margin on a real log, where
 * saturation has squeezed the top habits together and a gap carries no
 * information. 0.15 is over twice that, and a shade under the 0.17 that the
 * first evolution was actually decided on: the bar for *replacing* a branch is
 * comparable to the bar that chose it, and never lower.
 */
export const REEVOLVE_MARGIN = 0.15;

/**
 * Clamps on the window.
 *
 * Below the floor the window saturates differently from the one that decided
 * the first branch, so the comparison stops being like-for-like. Above the
 * ceiling it starts saturating like the whole log it exists to escape.
 */
export const REEVOLVE_WINDOW_MIN = 60;
export const REEVOLVE_WINDOW_MAX = 400;

/**
 * Commits a window needs before `night_owl` may win it.
 *
 * `night` is the only habit with no volume term — a bare
 * `nightCommits / commits.length`. Twelve commits, all after 22:00, score 1.0
 * outright and beat everything. Since a window is counted in habit-bearing
 * events, it can be mostly check transitions and hold very few commits, which
 * would make Night Owl the likeliest second evolution for a large class of
 * people on almost no evidence. Guarded here rather than in `night` itself,
 * because changing the score would move first evolutions already granted.
 */
export const NIGHT_OWL_MIN_COMMITS = 20;

/**
 * The events that say who somebody is: what they finished, and what they
 * un-broke. A red is evidence of nothing on its own — only the transition out
 * of it counts — and sessions and tool calls are participation, which this
 * project refuses to score anywhere.
 */
export function habitBearingKeys(
  events: readonly FamiliarEvent[],
  checks: CheckFoldResult,
): string[] {
  const transitions = new Set<string>([
    ...checks.fixes.map((f) => f.eventKey),
    ...checks.firstGreenRecords.map((r) => r.eventKey),
  ]);

  const keys: string[] = [];
  for (const event of events) {
    if (event.type === 'commit' || event.type === 'pr_merged' || transitions.has(event.key)) {
      keys.push(event.key);
    }
  }
  return keys;
}

/**
 * How much evidence the first evolution had, which is how much the second gets.
 *
 * Self-calibrating on purpose: then and now are then judged on equal evidence
 * and equal saturation, instead of on a constant that would suit one person's
 * rhythm and nobody else's. Null when the first evolution's event is not in the
 * log — a guessed N would invent the fairness this is here to provide.
 */
export function calibrateWindow(
  events: readonly FamiliarEvent[],
  checks: CheckFoldResult,
  firstEventKey: string,
): number | null {
  const index = events.findIndex((e) => e.key === firstEventKey);
  if (index < 0) return null;

  const upToThen = habitBearingKeys(events.slice(0, index + 1), checks).length;
  return Math.min(REEVOLVE_WINDOW_MAX, Math.max(REEVOLVE_WINDOW_MIN, upToThen));
}

export interface HabitWindow {
  scores: HabitScores;
  /** The span scored — every event from the window's start, not just the habit-bearing ones. */
  events: readonly FamiliarEvent[];
  counts: HabitCheckCounts;
}

/**
 * Habit scores over the last `n` habit-bearing events, boundary-correct.
 *
 * The check counts come from filtering a whole-log fold rather than folding the
 * span, because the fold carries per-slot state: fold a suffix and a green
 * whose red fell outside it becomes a *first green* instead of a *fix*, moving
 * score from firefighter to one_shot — exact complements. See countChecksIn.
 *
 * Null when the log holds fewer than `n`. The log only grows, so that normally
 * cannot happen; if the file has been truncated or hand-edited, the
 * equal-evidence premise is void and refusing is the honest answer.
 */
export function windowedHabits(
  events: readonly FamiliarEvent[],
  checks: CheckFoldResult,
  n: number,
): HabitWindow | null {
  const bearing = habitBearingKeys(events, checks);
  if (bearing.length < n) return null;

  const firstKey = bearing[bearing.length - n]!;
  const start = events.findIndex((e) => e.key === firstKey);
  if (start < 0) return null;

  const span = events.slice(start);
  const counts = countChecksIn(checks, new Set(span.map((e) => e.key)));
  return { scores: scoreHabits(span, counts), events: span, counts };
}

/**
 * Who beats the incumbent, and by how much. Null when nobody does.
 *
 * The gap is measured against the incumbent's own score in the same window, not
 * against the runner-up: the incumbent is never asked to defend a lead, only to
 * avoid being clearly beaten. Ties go to the incumbent, decided by
 * `selectBranch`'s existing BRANCHES-order determinism rather than any new rule.
 */
export function challengerFor(
  scores: HabitScores,
  incumbent: Branch,
): { branch: Branch; margin: number } | null {
  const branch = selectBranch(scores);
  if (branch === incumbent) return null;

  const margin = (scores[branchKey(branch)] ?? 0) - (scores[branchKey(incumbent)] ?? 0);
  return margin >= REEVOLVE_MARGIN ? { branch, margin } : null;
}

/** HabitScores is keyed by habit, not by branch; one place maps between them. */
function branchKey(branch: Branch): keyof HabitScores {
  switch (branch) {
    case 'night_owl':
      return 'night';
    case 'test_guardian':
      return 'test';
    case 'speed_demon':
      return 'speed';
    case 'one_shot':
      return 'oneShot';
    default:
      return branch;
  }
}

export interface ReevolveInput {
  /** Raw is fine — normalised here to match what deriveState scored. */
  events: readonly FamiliarEvent[];
  level: number;
  /** The branch in force now. */
  branch: Branch;
  /** Key of the event the first evolution happened on. */
  firstEventKey: string | null;
  alreadyReevolved: boolean;
}

export interface Reevolution {
  branch: Branch;
  /** The last event in the log — the moment this was settled. */
  eventKey: string;
  /** The branch replaced. For tests and the error log only: never displayed,
   *  never persisted. The old form is meant to leave no visible trace. */
  from: Branch;
  margin: number;
  /** The window actually used. */
  window: number;
  scores: HabitScores;
}

/**
 * The decision. Null unless every condition holds.
 *
 * Folds internally rather than accepting a fold, because the fold has to match
 * the normalised array the window's key set is built from — an API that let a
 * caller hand in a fold of the un-normalised log would corrupt the window with
 * no visible symptom.
 */
export function findReevolution(input: ReevolveInput): Reevolution | null {
  if (input.alreadyReevolved) return null;
  if (input.level < REEVOLVE_LEVEL) return null;
  if (!input.firstEventKey) return null;

  const events = dedupeEvents(sortEvents(input.events));
  const last = events[events.length - 1];
  if (!last) return null;

  const checks = foldChecks(events);
  const n = calibrateWindow(events, checks, input.firstEventKey);
  if (n === null) return null;

  const window = windowedHabits(events, checks, n);
  if (!window) return null;

  // The incumbent has to be able to defend itself. The check-dependent branches
  // score zero with no check evidence in the window, so somebody who uninstalls
  // the shell integration would be unseated by anything at all — a change of
  // tooling, not of habits. Mirrors the doctrine on CHECK_DEPENDENT_BRANCHES.
  const hasCheckEvidence = window.counts.fixes + window.counts.firstGreens > 0;
  if (!hasCheckEvidence && CHECK_DEPENDENT_BRANCHES.includes(input.branch)) return null;

  const challenger = challengerFor(window.scores, input.branch);
  if (!challenger) return null;

  if (challenger.branch === 'night_owl') {
    const commits = window.events.filter((e) => e.type === 'commit').length;
    if (commits < NIGHT_OWL_MIN_COMMITS) return null;
  }

  return {
    branch: challenger.branch,
    eventKey: last.key,
    from: input.branch,
    margin: challenger.margin,
    window: n,
    scores: window.scores,
  };
}

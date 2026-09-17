/**
 * The engine. A pure fold from an event log to a creature.
 *
 * Nothing here touches the filesystem and nothing is cached, which is what lets
 * the XP table be retuned freely: change a number and all of history re-scores
 * correctly on the next read, with no migration and no stale totals.
 */

import {
  foldChecks,
  summariseChecks,
  type CheckFoldResult,
  type CheckSummary,
} from './checks.js';
import { dedupeEvents, sortEvents, type EventType, type FamiliarEvent } from './events.js';
import { scoreHabits, selectBranch, type Branch, type HabitScores } from './habits.js';
import type { Species } from './species.js';

/**
 * XP per event. The single most important line in this project is the first
 * one: using a tool is worth nothing. Rewarding token burn rewards waste, and
 * an XP bar that fills while you spin your wheels is worse than no XP bar.
 */
export const XP_TABLE: Record<EventType, number> = {
  tool_used: 0,
  session_start: 1,
  commit: 5,
  pr_merged: 40,
  // Check observations are worth nothing on their own. A passing suite is not
  // an achievement — a suite that *started* passing is. That transition is
  // detected in checks.ts and scored there, so running the same green tests
  // twenty times earns exactly what it should: nothing.
  check_passed: 0,
  check_failed: 0,
  // Zero, never negative. Punishing red tests teaches you not to run them.
  tests_passed: 0,
  tests_failed: 0,
};

export const HATCH_LEVEL = 5;
export const EVOLVE_LEVEL = 15;
export const MAX_LEVEL = 100;

export type Stage = 'egg' | 'hatchling' | 'final';
export type Mood = 'happy' | 'neutral' | 'sad' | 'alarmed';

export interface CreatureState {
  species: Species;
  stage: Stage;
  /** Null until the creature reaches EVOLVE_LEVEL. */
  branch: Branch | null;
  level: number;
  xp: number;
  /** Cumulative XP at which the current level began. */
  levelFloor: number;
  /** Cumulative XP required for the next level. Null at MAX_LEVEL. */
  nextLevelAt: number | null;
  /** 0..1 progress through the current level. */
  progress: number;
  habits: HabitScores;
  /** Fixes, first passes and failures, derived from check transitions. */
  checks: CheckSummary;
  mood: Mood;
  totals: Record<EventType, number>;
  eventCount: number;
  lastEventAt: string | null;
  /** The event that pushed the creature into its current level, if any. */
  lastLevelUp: FamiliarEvent | null;
  /** The event that triggered evolution, if it has happened. */
  evolvedOn: FamiliarEvent | null;
}

/**
 * Curve shape. Quadratic means the marginal cost of a level grows *linearly* —
 * every level costs a constant 16 XP more than the one before it, which is a
 * rule a person can hold in their head.
 *
 * This replaced `10 * (L-1)^1.5`, which was barely superlinear: under it the
 * last level cost 149 XP and the fifteenth cost 55, so the whole back half of
 * the ladder was decorative and a steady developer reached the cap in weeks.
 *
 * The cap is 78,408 XP. A caution for whoever retunes this next: the log it
 * was first sized against ran at 158 XP/day, but three quarters of that was
 * teammates' commits the git scan used to count. The same developer's own
 * work was ~45 XP/day, which puts the cap nearer five years than one and a
 * half. Measure a filtered log before trusting a rate.
 */
const LEVEL_COST = 8;
const LEVEL_EXPONENT = 2;

/**
 * Which curve a familiar's evolution was decided under. Bump it whenever a
 * retune moves `totalXpForLevel(EVOLVE_LEVEL)`, and teach `lockEvolution` what
 * the previous threshold was.
 */
export const CURVE_VERSION = 2;

/**
 * What evolving cost before CURVE_VERSION 2: `10 * (15-1)^1.5`.
 *
 * Kept because the new curve charges three times as much to reach the evolve
 * level. Anybody who evolved between the two thresholds would otherwise fall
 * back to a hatchling on upgrade — and on re-crossing, `selectBranch` would
 * score a longer history than it originally did and could hand them a
 * *different* creature. The form is the one thing in Familiar that is earned
 * once, so it is the one thing a retune must not take back.
 */
export const LEGACY_EVOLVE_XP = 524;

/** Cumulative XP needed to *reach* a level. Level 1 costs nothing. */
export function totalXpForLevel(level: number): number {
  if (level <= 1) return 0;
  return Math.round(LEVEL_COST * Math.pow(level - 1, LEVEL_EXPONENT));
}

export function levelForXp(xp: number): number {
  if (xp <= 0) return 1;
  let level = 1;
  while (level < MAX_LEVEL && totalXpForLevel(level + 1) <= xp) level++;
  return level;
}

export function stageForLevel(level: number): Stage {
  if (level >= EVOLVE_LEVEL) return 'final';
  if (level >= HATCH_LEVEL) return 'hatchling';
  return 'egg';
}

/**
 * XP for one event. Check observations are looked up in the transition fold —
 * their value depends on what came before them, so it cannot live in a table.
 */
export function xpFor(event: FamiliarEvent, checks?: CheckFoldResult): number {
  const transition = checks?.xpByEventKey.get(event.key);
  if (transition !== undefined) return transition;
  return XP_TABLE[event.type] ?? 0;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Quiet for this long and the familiar goes sad — and starts saying so.
 *
 * Exported because the statusline needs the same threshold to decide when to
 * show an idle line. Two independent constants would drift, and a creature that
 * looks sad while claiming to be fine is worse than either alone.
 */
export const IDLE_AFTER_MS = 3 * DAY_MS;

function deriveMood(events: readonly FamiliarEvent[], now: number): Mood {
  const recent = events.filter((e) => now - Date.parse(e.t) <= 2 * DAY_MS);

  if (recent.length === 0) {
    const last = events[events.length - 1];
    // Quiet for days. Sad, not scolding — it misses you, it isn't judging you.
    if (!last || now - Date.parse(last.t) > IDLE_AFTER_MS) return 'sad';
    return 'neutral';
  }

  // The most recent *meaningful* signal wins, newest first.
  for (let i = recent.length - 1; i >= 0; i--) {
    const type = recent[i]?.type;
    if (type === 'check_failed' || type === 'tests_failed') return 'alarmed';
    if (type === 'pr_merged' || type === 'check_passed' || type === 'tests_passed') {
      return 'happy';
    }
  }
  return 'neutral';
}

function emptyTotals(): Record<EventType, number> {
  return {
    session_start: 0,
    tool_used: 0,
    commit: 0,
    pr_merged: 0,
    check_passed: 0,
    check_failed: 0,
    tests_passed: 0,
    tests_failed: 0,
  };
}

/** A branch fixed at the moment it was earned, and the event that earned it. */
export interface EvolutionRecord {
  branch: Branch;
  /** Key of the event that crossed the threshold; null if it is not known. */
  eventKey: string | null;
}

export interface DeriveOptions {
  species?: Species;
  /**
   * An evolution that already happened. When present it wins outright: the
   * fold neither re-decides the branch nor lets a lower level undo the form.
   * XP and level still re-derive freely — only identity is sticky.
   */
  evolution?: EvolutionRecord | null;
  /** Overridable so tests and the widget can reason about a fixed moment. */
  now?: Date;
}

/**
 * Folds the log into a creature.
 *
 * Branch selection happens *at the moment* the creature crosses EVOLVE_LEVEL,
 * scored on the events up to that point, so later events cannot re-decide it —
 * evolution should be a moment, not a weekly reshuffle.
 *
 * That lock only holds while the curve stands still: retune it and the moment
 * moves. So once an evolution has happened it is also saved (see
 * state/identity.ts) and handed back in as `options.evolution`, which wins over
 * the fold. Everything else here stays derived.
 */
export function deriveState(
  rawEvents: readonly FamiliarEvent[],
  options: DeriveOptions = {},
): CreatureState {
  const events = dedupeEvents(sortEvents(rawEvents));
  const now = (options.now ?? new Date()).getTime();

  // Resolve transitions up front. The fold returns XP keyed by event, so the
  // main loop below still awards strictly in order and can tell exactly which
  // event pushed the creature over a level boundary.
  const checks = foldChecks(events);

  const locked = options.evolution ?? null;

  let xp = 0;
  let level = 1;
  let branch: Branch | null = locked?.branch ?? null;
  let evolvedOn: FamiliarEvent | null =
    locked?.eventKey != null ? (events.find((e) => e.key === locked.eventKey) ?? null) : null;
  let lastLevelUp: FamiliarEvent | null = null;
  const totals = emptyTotals();

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!event) continue;

    totals[event.type] = (totals[event.type] ?? 0) + 1;
    xp += xpFor(event, checks);

    const newLevel = levelForXp(xp);
    if (newLevel > level) {
      level = newLevel;
      lastLevelUp = event;

      if (branch === null && level >= EVOLVE_LEVEL) {
        branch = selectBranch(scoreHabits(events.slice(0, i + 1)));
        evolvedOn = event;
      }
    }
  }

  const levelFloor = totalXpForLevel(level);
  const nextLevelAt = level >= MAX_LEVEL ? null : totalXpForLevel(level + 1);
  const span = nextLevelAt === null ? 0 : nextLevelAt - levelFloor;
  const progress = span > 0 ? Math.min(1, Math.max(0, (xp - levelFloor) / span)) : 1;

  const last = events[events.length - 1];

  return {
    species: options.species ?? 'sprout',
    // A locked branch means the creature already evolved, whatever level the
    // current curve puts it at.
    stage: branch !== null ? 'final' : stageForLevel(level),
    branch,
    level,
    xp,
    levelFloor,
    nextLevelAt,
    progress,
    habits: scoreHabits(events),
    checks: summariseChecks(checks),
    mood: deriveMood(events, now),
    totals,
    eventCount: events.length,
    lastEventAt: last ? last.t : null,
    lastLevelUp,
    evolvedOn,
  };
}

/**
 * When, and into what, a log evolves at a given XP threshold.
 *
 * The same decision the fold makes — first event whose cumulative XP reaches
 * the threshold, branch scored on everything up to and including it — exposed
 * on its own so an evolution can be recovered under a threshold the fold no
 * longer uses.
 */
export function findEvolution(
  rawEvents: readonly FamiliarEvent[],
  xpToEvolve: number = totalXpForLevel(EVOLVE_LEVEL),
): EvolutionRecord | null {
  const events = dedupeEvents(sortEvents(rawEvents));
  const checks = foldChecks(events);

  let xp = 0;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!event) continue;
    xp += xpFor(event, checks);
    if (xp >= xpToEvolve) {
      return { branch: selectBranch(scoreHabits(events.slice(0, i + 1))), eventKey: event.key };
    }
  }
  return null;
}

export interface EvolutionLock {
  evolution: EvolutionRecord | null;
  curve: number;
}

/**
 * Brings a stored evolution up to the current curve.
 *
 * - Something already locked stays locked.
 * - A familiar last seen on an older curve gets the evolution it earned under
 *   that curve, recovered from the log — this is what stops the retune
 *   de-evolving anybody.
 * - A familiar already on the current curve with nothing locked has not
 *   evolved yet, and the fold decides that as it always did.
 *
 * Pure: the caller decides whether to save the result.
 */
export function lockEvolution(stored: EvolutionLock, events: readonly FamiliarEvent[]): EvolutionLock {
  if (stored.evolution) return { evolution: stored.evolution, curve: CURVE_VERSION };
  if (stored.curve < CURVE_VERSION) {
    return { evolution: findEvolution(events, LEGACY_EVOLVE_XP), curve: CURVE_VERSION };
  }
  return { evolution: null, curve: stored.curve };
}

/** Events inside the trailing 7 days, for the "this week" line on the card. */
export function weeklyTotals(
  events: readonly FamiliarEvent[],
  now = new Date(),
): Record<EventType, number> {
  const cutoff = now.getTime() - 7 * DAY_MS;
  const totals = emptyTotals();
  for (const e of dedupeEvents(events)) {
    if (Date.parse(e.t) >= cutoff) totals[e.type] = (totals[e.type] ?? 0) + 1;
  }
  return totals;
}

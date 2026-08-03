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
  pr_opened: 15,
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
export const MAX_LEVEL = 99;

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

/** Cumulative XP needed to *reach* a level. Level 1 costs nothing. */
export function totalXpForLevel(level: number): number {
  if (level <= 1) return 0;
  return Math.round(10 * Math.pow(level - 1, 1.5));
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
    if (
      type === 'pr_merged' ||
      type === 'pr_opened' ||
      type === 'check_passed' ||
      type === 'tests_passed'
    ) {
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
    pr_opened: 0,
    pr_merged: 0,
    check_passed: 0,
    check_failed: 0,
    tests_passed: 0,
    tests_failed: 0,
  };
}

export interface DeriveOptions {
  species?: Species;
  /** Overridable so tests and the widget can reason about a fixed moment. */
  now?: Date;
}

/**
 * Folds the log into a creature.
 *
 * Branch selection happens *at the moment* the creature crosses EVOLVE_LEVEL,
 * scored on the events up to that point — so it locks naturally, without being
 * persisted anywhere. Later events cannot re-decide it, which is the point:
 * evolution should be a moment, not a weekly reshuffle.
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

  let xp = 0;
  let level = 1;
  let branch: Branch | null = null;
  let evolvedOn: FamiliarEvent | null = null;
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
    stage: stageForLevel(level),
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

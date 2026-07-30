/**
 * Habit scoring. Decides which branch a familiar evolves down.
 *
 * These read *content and timing* of what you do. Species scoring (species.ts)
 * reads *rhythm*. Keeping the two orthogonal is deliberate: if both read the
 * same signal, the "which branch did I get?" reveal would be a foregone
 * conclusion from the moment you ran `init`.
 */

import { foldChecks, summariseChecks } from './checks.js';
import type { FamiliarEvent } from './events.js';

export const BRANCHES = [
  'night_owl',
  'test_guardian',
  'speed_demon',
  'firefighter',
  'refactorer',
  'one_shot',
  'conjurer',
] as const;
export type Branch = (typeof BRANCHES)[number];

export const BRANCH_LABELS: Record<Branch, string> = {
  night_owl: 'Night Owl',
  test_guardian: 'Test Guardian',
  speed_demon: 'Speed Demon',
  firefighter: 'Firefighter',
  refactorer: 'Refactorer',
  one_shot: 'One-Shot',
  conjurer: 'Conjurer',
};

export const BRANCH_EMOJI: Record<Branch, string> = {
  night_owl: '🦉',
  test_guardian: '🧪',
  speed_demon: '⚡',
  firefighter: '🔥',
  refactorer: '🛠️',
  one_shot: '🎯',
  conjurer: '🪄',
};

/**
 * The last four are only reachable once something is reporting check outcomes
 * — the terminal adapter or the Claude Code hook. On git alone they stay at
 * zero, so a git-only user gets a complete but smaller tree rather than a
 * branch they can never win.
 */
export const CHECK_DEPENDENT_BRANCHES: readonly Branch[] = [
  'firefighter',
  'refactorer',
  'one_shot',
  'conjurer',
];

export interface HabitScores {
  /** 0..1 — share of work done between 22:00 and 05:00. */
  night: number;
  /** 0..1 — how much of your work is tests. */
  test: number;
  /** 0..1 — how fast and dense your shipping is. */
  speed: number;
  /** 0..1 — how much of your work is fixing things that broke. */
  firefighter: number;
  /** 0..1 — how much of it is going green without changing behaviour. */
  refactorer: number;
  /** 0..1 — how often checks pass without ever having gone red. */
  oneShot: number;
  /** 0..1 — how much of your fixing happens alongside an agent. */
  conjurer: number;
}

/** Hours counted as "night". Inclusive of 22, 23, 0, 1, 2, 3, 4. */
export function isNightHour(hour: number): boolean {
  return hour >= 22 || hour < 5;
}

/** Maps an unbounded count onto 0..1 with diminishing returns. */
function saturate(value: number, halfway: number): number {
  if (value <= 0) return 0;
  return value / (value + halfway);
}

export function scoreHabits(events: readonly FamiliarEvent[]): HabitScores {
  const commits = events.filter((e) => e.type === 'commit');
  const testsPassed = events.filter((e) => e.type === 'tests_passed').length;
  const merges = events.filter((e) => e.type === 'pr_merged').length;

  // --- night -------------------------------------------------------------
  // Share of commits made at night. With no commits there is no signal, so 0.
  let night = 0;
  if (commits.length > 0) {
    const nightCommits = commits.filter((e) => {
      const hour = e.meta.hour;
      return typeof hour === 'number' && isNightHour(hour);
    }).length;
    night = nightCommits / commits.length;
  }

  // --- test --------------------------------------------------------------
  // Half from "do your commits touch tests", half from "do you run them green".
  const testTouchRatio =
    commits.length > 0 ? commits.filter((e) => e.meta.touchedTests === true).length / commits.length : 0;
  const testRunScore = saturate(testsPassed, 8);
  const test = 0.6 * testTouchRatio + 0.4 * testRunScore;

  // --- speed -------------------------------------------------------------
  // Density of commits on the days you work, plus how often things actually
  // land. Density alone would reward thrashing; merges alone are too sparse.
  const activeDays = new Set(commits.map((e) => e.t.slice(0, 10))).size;
  const perActiveDay = activeDays > 0 ? commits.length / activeDays : 0;
  const density = saturate(perActiveDay, 6);
  const landing = saturate(merges, 4);
  const speed = 0.5 * density + 0.5 * landing;

  // --- check-derived branches --------------------------------------------
  // Every one is share x volume. Share alone would let a single lucky fix win
  // a branch outright; volume alone would just track who runs more commands.
  const checks = summariseChecks(foldChecks(events));
  const greens = checks.fixes + checks.firstGreens;

  const fixShare = greens > 0 ? checks.fixes / greens : 0;
  const firefighter = 0.6 * saturate(checks.fixes, 6) + 0.4 * fixShare;

  const quietFixes =
    checks.fixesByKind.typecheck + checks.fixesByKind.build + checks.fixesByKind.lint;
  const quietShare = checks.fixes > 0 ? quietFixes / checks.fixes : 0;
  const refactorer = 0.5 * quietShare + 0.5 * saturate(quietFixes, 4);

  // Deliberately the inverse of firefighter: never breaking is its own skill.
  const cleanShare = greens > 0 ? checks.firstGreens / greens : 0;
  const oneShot = 0.5 * cleanShare + 0.5 * saturate(checks.firstGreens, 8);

  const agentShare = checks.fixes > 0 ? checks.fixesWithAgent / checks.fixes : 0;
  const conjurer = 0.5 * agentShare + 0.5 * saturate(checks.fixesWithAgent, 4);

  return { night, test, speed, firefighter, refactorer, oneShot, conjurer };
}

/**
 * Picks the winning branch. Ties break in BRANCHES order, which makes the
 * result deterministic — important, because a familiar that could evolve two
 * different ways from identical history would feel broken.
 */
export function selectBranch(scores: HabitScores): Branch {
  const ordered: Array<[Branch, number]> = [
    ['night_owl', scores.night],
    ['test_guardian', scores.test],
    ['speed_demon', scores.speed],
    ['firefighter', scores.firefighter],
    ['refactorer', scores.refactorer],
    ['one_shot', scores.oneShot],
    ['conjurer', scores.conjurer],
  ];

  let best: Branch = 'night_owl';
  let bestScore = -Infinity;
  for (const [branch, score] of ordered) {
    if (score > bestScore) {
      best = branch;
      bestScore = score;
    }
  }
  return best;
}

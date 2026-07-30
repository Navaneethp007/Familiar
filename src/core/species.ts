/**
 * Species selection — the seeding step.
 *
 * Run once at `init` against ~60 days of past git history. Per the idea doc's
 * rule: git history seeds *personality*, not *level*. Nothing here awards XP.
 * Backfilling levels would hand you a maxed creature and skip the whole game.
 *
 * Scored on **rhythm only** (how often and how evenly you commit), never on
 * content or time-of-day — those belong to branch selection in habits.ts.
 */

export const SPECIES = ['sprout', 'ember', 'wisp'] as const;
export type Species = (typeof SPECIES)[number];

export const SPECIES_LABELS: Record<Species, string> = {
  sprout: 'Sprout',
  ember: 'Ember',
  wisp: 'Wisp',
};

export const SPECIES_BLURBS: Record<Species, string> = {
  sprout: 'steady hands — you show up and commit, day after day',
  ember: 'you work in bursts — quiet, then everything at once',
  wisp: 'scattered and irregular — you appear when you appear',
};

export interface RhythmProfile {
  windowDays: number;
  totalCommits: number;
  activeDays: number;
  /** Share of days in the window with at least one commit. */
  activeRatio: number;
  commitsPerActiveDay: number;
  /** Longest run of consecutive commit-free days inside the window. */
  longestGapDays: number;
}

export interface SpeciesScores {
  sprout: number;
  ember: number;
  wisp: number;
}

function saturate(value: number, halfway: number): number {
  if (value <= 0) return 0;
  return value / (value + halfway);
}

/** Reduces raw commit timestamps to the rhythm numbers species scoring needs. */
export function profileRhythm(dates: readonly Date[], windowDays = 60, now = new Date()): RhythmProfile {
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  const inWindow = dates.filter((d) => d.getTime() >= cutoff && d.getTime() <= now.getTime());

  const dayKeys = new Set<string>();
  for (const d of inWindow) {
    dayKeys.add(`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`);
  }
  const activeDays = dayKeys.size;

  // Longest gap: walk the sorted active-day offsets and measure the biggest
  // jump, including the run from the window's start and up to now.
  const offsets = [...inWindow]
    .map((d) => Math.floor((now.getTime() - d.getTime()) / (24 * 60 * 60 * 1000)))
    .sort((a, b) => a - b);
  let longestGapDays = windowDays;
  if (offsets.length > 0) {
    const first = offsets[0] ?? 0;
    let longest = first; // days since the most recent commit
    const last = offsets[offsets.length - 1] ?? 0;
    longest = Math.max(longest, windowDays - last); // silence before the first commit
    for (let i = 1; i < offsets.length; i++) {
      const gap = (offsets[i] ?? 0) - (offsets[i - 1] ?? 0);
      if (gap > longest) longest = gap;
    }
    longestGapDays = longest;
  }

  return {
    windowDays,
    totalCommits: inWindow.length,
    activeDays,
    activeRatio: windowDays > 0 ? activeDays / windowDays : 0,
    commitsPerActiveDay: activeDays > 0 ? inWindow.length / activeDays : 0,
    longestGapDays,
  };
}

export function scoreSpecies(profile: RhythmProfile): SpeciesScores {
  const { activeRatio, commitsPerActiveDay, longestGapDays, windowDays } = profile;

  // Steady: you commit on a large share of days, without long silences.
  const regularity = Math.min(1, activeRatio / 0.5);
  const continuity = 1 - Math.min(1, longestGapDays / Math.max(1, windowDays * 0.25));
  const sprout = 0.6 * regularity + 0.4 * continuity;

  // Bursty: not many active days, but enormous ones when they happen.
  const intensity = saturate(commitsPerActiveDay, 6);
  const concentration = 1 - Math.min(1, activeRatio / 0.4);
  const ember = 0.65 * intensity + 0.35 * concentration;

  // Sporadic: thin overall and full of holes.
  const sparsity = 1 - Math.min(1, activeRatio / 0.3);
  const gappiness = Math.min(1, longestGapDays / Math.max(1, windowDays * 0.2));
  const lowVolume = 1 - saturate(commitsPerActiveDay, 4);
  const wisp = 0.4 * sparsity + 0.35 * gappiness + 0.25 * lowVolume;

  return { sprout, ember, wisp };
}

/**
 * Picks a species from a rhythm profile. With no history at all there is no
 * signal to read, so we hand out the neutral starter rather than pretending
 * an empty machine told us something about the person using it.
 */
export function selectSpecies(profile: RhythmProfile): Species {
  if (profile.totalCommits === 0) return 'sprout';

  const scores = scoreSpecies(profile);
  const ordered: Array<[Species, number]> = [
    ['sprout', scores.sprout],
    ['ember', scores.ember],
    ['wisp', scores.wisp],
  ];

  let best: Species = 'sprout';
  let bestScore = -Infinity;
  for (const [species, score] of ordered) {
    if (score > bestScore) {
      best = species;
      bestScore = score;
    }
  }
  return best;
}

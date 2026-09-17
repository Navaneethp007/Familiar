/**
 * Landmarks. The thing that still arrives once the ladder has run out.
 *
 * A milestone is a cumulative count crossing a threshold — your hundredth fix,
 * your thousandth commit. It is announced exactly like a level up and, like a
 * level up, it is **derived, never stored**: the crossing is a pure function of
 * the two folds `hook.ts` already computes on either side of an append. There
 * is no ledger of what has been announced, and there must never be one.
 *
 * Two rules decide what may be a track:
 *
 * 1. **Counts, never ratios.** Every `HabitScores` field is a 0..1 share, so a
 *    threshold on one could be crossed by doing *less of everything else*. That
 *    would smuggle activity-gaming in through a side door, which is the one
 *    thing this project exists to refuse.
 * 2. **Only things that already earn XP.** `XP_TABLE` and `checks.ts` have
 *    already ranked what counts as an outcome. A milestone track is one of
 *    those, minus participation.
 *
 * So: `tool_used` (worth 0 XP — a tool-use landmark would reinstate exactly the
 * thing the XP table refuses), `session_start` (participation), `eventCount`
 * (dominated by tool_used), `redundantGreens` (the repetition that pays
 * nothing) and `firstGreens` (already voiced through `coldFirstGreens`) are all
 * excluded on purpose.
 */

import type { SpeakKey } from './tone.js';
import type { CreatureState } from './xp.js';

/** Ordered by the XP their underlying outcome earns: 40 > 20 > 5. Ties break here. */
export const MILESTONE_TRACKS = ['merges', 'fixes', 'commits'] as const;
export type MilestoneTrack = (typeof MILESTONE_TRACKS)[number];

/**
 * Log-spaced, not a fixed interval.
 *
 * "Every 100 commits" is wrong at both ends: a newcomer waits weeks for their
 * first, and somebody 600 commits in gets one every fortnight forever with no
 * escalation — and a thing that arrives on a schedule stops being an event.
 * Log spacing holds the *effort ratio* between rungs constant, so the ladder is
 * dense where somebody is new and sparse where they are established, with no
 * per-user tuning. About 27 crossings in a familiar's whole life, which is
 * rarer than levelling — that rarity is what earns it a high rung in the speak
 * ladder and a pass on the cooldown.
 *
 * No ladder starts at 1. A first merge and a first fix ARE distinct moments,
 * but `pr_merged` and `check_fixed` already own them, and they own them with
 * the right words — landmark lines are written for large counts, so firing one
 * on number one reads as sarcasm ("that many saves is a record" on your first
 * save). Milestones sit above those keys in the speak ladder, so a rung at 1
 * does not add a moment, it steals one.
 */
export const MILESTONES: Readonly<Record<MilestoneTrack, readonly number[]>> = {
  merges: [10, 25, 50, 100, 250, 500, 1000, 2500],
  fixes: [10, 25, 50, 100, 250, 500, 1000, 2500],
  commits: [50, 100, 250, 500, 1000, 2500, 5000, 10000],
};

const SPEAK_KEYS_BY_TRACK: Record<MilestoneTrack, SpeakKey> = {
  merges: 'milestone_merges',
  fixes: 'milestone_fixes',
  commits: 'milestone_commits',
};

export interface Milestone {
  track: MilestoneTrack;
  threshold: number;
  /** Position in its own ladder, 0-based. How deep in, not how big. */
  rank: number;
  /** `track:threshold` — the stable seed, so one milestone always says one thing. */
  id: string;
}

/**
 * The counts a milestone may be built on.
 *
 * A `Pick` rather than the whole state: it keeps this module's dependency on
 * `xp.ts` type-only, and it lets the tests hand in two object literals instead
 * of synthesising a thousand merges to reach a threshold of a thousand.
 */
export type MilestoneCounts = Pick<CreatureState, 'totals' | 'checks'>;

/** The all-time cumulative count behind a track. */
export function milestoneCount(state: MilestoneCounts, track: MilestoneTrack): number {
  switch (track) {
    case 'merges':
      return state.totals.pr_merged;
    case 'commits':
      return state.totals.commit;
    case 'fixes':
      return state.checks.fixes;
  }
}

export function milestoneSpeakKey(track: MilestoneTrack): SpeakKey {
  return SPEAK_KEYS_BY_TRACK[track];
}

/** Every threshold strictly crossed going from `before` to `after`, ascending. */
export function crossedMilestones(before: MilestoneCounts, after: MilestoneCounts): Milestone[] {
  const crossed: Milestone[] = [];

  for (const track of MILESTONE_TRACKS) {
    const was = milestoneCount(before, track);
    const now = milestoneCount(after, track);
    // The log is append-only, so a count should never fall. If one somehow
    // does, the answer is "nothing happened", not a thrown hook.
    if (now <= was) continue;

    MILESTONES[track].forEach((threshold, rank) => {
      if (was < threshold && now >= threshold) {
        crossed.push({ track, threshold, rank, id: `${track}:${threshold}` });
      }
    });
  }

  return crossed.sort((a, b) => a.threshold - b.threshold);
}

/**
 * The one worth speaking on, or null.
 *
 * The familiar has a single voice and no queue, so when a batch crosses
 * several the rarest wins. Rarity is `rank` — depth into a ladder — because raw
 * thresholds are not comparable across tracks: 1,000 commits is a lesser feat
 * than 250 merges, and only the rung number says so. Ties fall back to
 * `MILESTONE_TRACKS` order, the same determinism discipline `selectBranch` uses.
 */
export function highestMilestone(
  before: MilestoneCounts,
  after: MilestoneCounts,
): Milestone | null {
  let best: Milestone | null = null;

  for (const milestone of crossedMilestones(before, after)) {
    if (best === null || milestone.rank > best.rank) {
      best = milestone;
      continue;
    }
    if (milestone.rank === best.rank) {
      const challenger = MILESTONE_TRACKS.indexOf(milestone.track);
      const holder = MILESTONE_TRACKS.indexOf(best.track);
      if (challenger < holder) best = milestone;
    }
  }

  return best;
}

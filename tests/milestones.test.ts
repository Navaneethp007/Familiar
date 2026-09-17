import { describe, expect, it } from 'vitest';

import type { CheckSummary } from '../src/core/checks.js';
import type { EventType } from '../src/core/events.js';
import {
  crossedMilestones,
  highestMilestone,
  milestoneCount,
  milestoneSpeakKey,
  MILESTONES,
  MILESTONE_TRACKS,
} from '../src/core/milestones.js';
import { SPEAK_KEYS } from '../src/core/tone.js';
import type { CreatureState } from '../src/core/xp.js';

/**
 * Milestones read two fields of a CreatureState, so the fixtures are two plain
 * objects rather than event logs. That is the whole reason the functions take
 * a `Pick<>` — building 1,000 merges to test a threshold at 1,000 would make
 * these tests slower than the engine they cover.
 */
type Counts = Pick<CreatureState, 'totals' | 'checks'>;

function counts(over: { commits?: number; merges?: number; fixes?: number } = {}): Counts {
  const totals: Record<EventType, number> = {
    session_start: 0,
    tool_used: 0,
    commit: over.commits ?? 0,
    pr_merged: over.merges ?? 0,
    check_passed: 0,
    check_failed: 0,
    tests_passed: 0,
    tests_failed: 0,
  };
  const checks = {
    fixes: over.fixes ?? 0,
    firstGreens: 0,
    failures: 0,
    fixesByKind: { test: 0, build: 0, typecheck: 0, lint: 0 },
    fixesWithAgent: 0,
    redundantGreens: 0,
    lastFix: null,
    coldFirstGreens: 0,
    lastColdGreen: null,
  } satisfies CheckSummary;
  return { totals, checks };
}

describe('the milestone ladders', () => {
  it('is strictly ascending and never starts at zero', () => {
    for (const track of MILESTONE_TRACKS) {
      const ladder = MILESTONES[track];
      expect(ladder.length, track).toBeGreaterThan(0);
      expect(ladder[0], track).toBeGreaterThan(0);
      for (let i = 1; i < ladder.length; i++) {
        expect(ladder[i], `${track}[${i}]`).toBeGreaterThan(ladder[i - 1]!);
      }
    }
  });

  it('speaks through a key the familiar actually has', () => {
    for (const track of MILESTONE_TRACKS) {
      expect(SPEAK_KEYS).toContain(milestoneSpeakKey(track));
    }
  });

  it('gives every track its own voice', () => {
    const keys = MILESTONE_TRACKS.map(milestoneSpeakKey);
    expect(new Set(keys).size).toBe(MILESTONE_TRACKS.length);
  });
});

describe('milestoneCount', () => {
  it('reads the all-time cumulative count for each track', () => {
    const state = counts({ commits: 7, merges: 3, fixes: 11 });
    expect(milestoneCount(state, 'commits')).toBe(7);
    expect(milestoneCount(state, 'merges')).toBe(3);
    expect(milestoneCount(state, 'fixes')).toBe(11);
  });

  /**
   * The load-bearing test of the whole feature. A milestone must never be
   * backed by a ratio or by participation — a ratio can be crossed by doing
   * LESS of everything else, and rewarding participation is the exact thing
   * this project refuses. Inflating all of them must change nothing.
   */
  it('ignores activity, participation and every ratio', () => {
    const before = counts({ commits: 5, merges: 5, fixes: 5 });
    const after: Counts = {
      totals: {
        ...before.totals,
        tool_used: 100_000,
        session_start: 5_000,
        check_passed: 5_000,
        check_failed: 5_000,
        tests_passed: 5_000,
        tests_failed: 5_000,
      },
      checks: {
        ...before.checks,
        firstGreens: 9_999,
        failures: 9_999,
        redundantGreens: 9_999,
        coldFirstGreens: 9_999,
        fixesWithAgent: 9_999,
      },
    };
    expect(crossedMilestones(before, after)).toEqual([]);
    expect(highestMilestone(before, after)).toBeNull();
  });
});

describe('crossing a threshold', () => {
  it('fires exactly on the threshold, not before', () => {
    expect(highestMilestone(counts({ merges: 8 }), counts({ merges: 9 }))).toBeNull();
    expect(highestMilestone(counts({ merges: 9 }), counts({ merges: 10 }))?.threshold).toBe(10);
  });

  it('does not fire again once the threshold is behind you', () => {
    expect(highestMilestone(counts({ merges: 10 }), counts({ merges: 11 }))).toBeNull();
    expect(highestMilestone(counts({ merges: 11 }), counts({ merges: 24 }))).toBeNull();
  });

  it('stays silent when nothing moved', () => {
    const same = counts({ commits: 500, merges: 250, fixes: 100 });
    expect(highestMilestone(same, same)).toBeNull();
  });

  it('reports every threshold a single batch jumped over', () => {
    const crossed = crossedMilestones(counts({ commits: 0 }), counts({ commits: 300 }));
    expect(crossed.map((m) => m.threshold)).toEqual([50, 100, 250]);
  });

  it('speaks only the deepest one when a batch crosses several', () => {
    expect(highestMilestone(counts({ commits: 0 }), counts({ commits: 300 }))?.threshold).toBe(250);
  });

  it('carries a stable id so the same milestone always says the same thing', () => {
    const first = highestMilestone(counts({ fixes: 99 }), counts({ fixes: 100 }));
    const again = highestMilestone(counts({ fixes: 99 }), counts({ fixes: 140 }));
    expect(first?.id).toBe('fixes:100');
    expect(again?.id).toBe(first?.id);
  });

  it('counts backwards movement as nothing rather than crashing', () => {
    // The log is append-only, so this should be impossible — but a surface
    // that throws on it would take the whole hook down with it.
    expect(highestMilestone(counts({ commits: 500 }), counts({ commits: 3 }))).toBeNull();
  });
});

describe('choosing between tracks', () => {
  it('prefers the rarer achievement over the bigger number', () => {
    // 1,000 commits is the 6th rung of its ladder; 100 merges is the 5th.
    // Raw thresholds are not comparable across tracks — depth is.
    const chosen = highestMilestone(
      counts({ commits: 999, merges: 99 }),
      counts({ commits: 1000, merges: 100 }),
    );
    expect(chosen?.track).toBe('commits');
    expect(chosen?.threshold).toBe(1000);
  });

  it('breaks a tie in track order, which is XP-table order', () => {
    // Same rung on all three ladders. merges (40xp) outranks fixes (20xp),
    // which outranks commits (5xp).
    const chosen = highestMilestone(counts({ merges: 9, fixes: 9 }), counts({ merges: 10, fixes: 10 }));
    expect(chosen?.track).toBe('merges');
  });

  it('is deterministic', () => {
    const before = counts({ commits: 99, merges: 24, fixes: 49 });
    const after = counts({ commits: 260, merges: 30, fixes: 55 });
    const runs = Array.from({ length: 20 }, () => highestMilestone(before, after)?.id);
    expect(new Set(runs).size).toBe(1);
  });
});

describe('the tracks themselves', () => {
  // A first merge and a first fix belong to pr_merged and check_fixed, which
  // have words for them. Landmark banks are written for large counts, so a
  // rung at 1 would fire "that many saves is a record" on save number one.
  it('never claims a landmark on a first anything', () => {
    for (const track of MILESTONE_TRACKS) {
      expect(MILESTONES[track][0], track).toBeGreaterThan(1);
    }
    const virgin = counts();
    expect(highestMilestone(virgin, counts({ merges: 1, fixes: 1, commits: 1 }))).toBeNull();
  });

  it('keeps climbing for somebody who has been at it for months', () => {
    // A real log sat at 637 commits / 186 merges / 113 fixes. Every track must
    // still have somewhere to go from there, or it becomes wallpaper.
    const veteran = counts({ commits: 637, merges: 186, fixes: 113 });
    for (const track of MILESTONE_TRACKS) {
      const ladder = MILESTONES[track];
      const ahead = ladder.filter((t) => t > milestoneCount(veteran, track));
      expect(ahead.length, track).toBeGreaterThan(0);
    }
  });
});

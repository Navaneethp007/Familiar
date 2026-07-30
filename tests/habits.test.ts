import { describe, expect, it } from 'vitest';

import { makeEvent, type FamiliarEvent } from '../src/core/events.js';
import { BRANCHES, isNightHour, scoreHabits, selectBranch } from '../src/core/habits.js';
import { deriveState, EVOLVE_LEVEL, totalXpForLevel } from '../src/core/xp.js';
import { series } from './helpers.js';

function commitsAt(hours: number[], meta: Record<string, unknown> = {}): FamiliarEvent[] {
  return hours.map((hour, i) =>
    makeEvent({
      type: 'commit',
      source: 'manual',
      key: `commit:h${i}:${hour}`,
      at: new Date(2026, 6, 1 + i, hour, 0, 0),
      meta: { hour, ...meta },
    }),
  );
}

describe('isNightHour', () => {
  it('covers 22:00 through 04:59', () => {
    for (const hour of [22, 23, 0, 1, 2, 3, 4]) expect(isNightHour(hour)).toBe(true);
    for (const hour of [5, 9, 12, 17, 21]) expect(isNightHour(hour)).toBe(false);
  });
});

describe('scoreHabits', () => {
  it('returns zeroes for an empty log rather than NaN', () => {
    const scores = scoreHabits([]);
    for (const value of Object.values(scores)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBe(0);
    }
  });

  it('scores an all-night history at the top for night', () => {
    expect(scoreHabits(commitsAt([2, 3, 23, 1])).night).toBe(1);
  });

  it('scores a daytime history at zero for night', () => {
    expect(scoreHabits(commitsAt([9, 11, 14, 16])).night).toBe(0);
  });

  it('rewards commits that touch tests', () => {
    const withTests = scoreHabits(commitsAt([10, 11, 12], { touchedTests: true })).test;
    const without = scoreHabits(commitsAt([10, 11, 12], { touchedTests: false })).test;
    expect(withTests).toBeGreaterThan(without);
  });

  it('keeps every score inside 0..1', () => {
    const busy = [...series('commit', 200), ...series('pr_merged', 50), ...series('tests_passed', 80)];
    for (const value of Object.values(scoreHabits(busy))) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('selectBranch', () => {
  it('picks the highest score', () => {
    expect(selectBranch({ night: 0.9, test: 0.2, speed: 0.1 })).toBe('night_owl');
    expect(selectBranch({ night: 0.1, test: 0.8, speed: 0.3 })).toBe('test_guardian');
    expect(selectBranch({ night: 0.2, test: 0.2, speed: 0.7 })).toBe('speed_demon');
  });

  it('breaks ties deterministically', () => {
    const tied = { night: 0.5, test: 0.5, speed: 0.5 };
    const first = selectBranch(tied);
    expect(first).toBe(BRANCHES[0]);
    for (let i = 0; i < 20; i++) expect(selectBranch(tied)).toBe(first);
  });
});

describe('check-derived branches', () => {
  let n = 0;

  /** A red then a green for the same slot — one fix. */
  function fix(opts: { kind?: string; agent?: string | null; repo?: string } = {}): FamiliarEvent[] {
    n++;
    const meta = {
      kind: opts.kind ?? 'test',
      repoPath: opts.repo ?? '/repo/a',
      agent: opts.agent ?? null,
    };
    return [
      makeEvent({
        type: 'check_failed',
        source: 'terminal',
        key: `f:${n}`,
        at: new Date(2026, 6, 1, 10, n * 2),
        meta,
      }),
      makeEvent({
        type: 'check_passed',
        source: 'terminal',
        key: `p:${n}`,
        at: new Date(2026, 6, 1, 10, n * 2 + 1),
        meta,
      }),
    ];
  }

  /** A green with no prior red — a clean first pass. */
  function cleanPass(kind = 'test'): FamiliarEvent[] {
    n++;
    return [
      makeEvent({
        type: 'check_passed',
        source: 'terminal',
        key: `c:${n}`,
        at: new Date(2026, 6, 1, 10, n * 2),
        // A distinct repo each time, so each really is a first pass.
        meta: { kind, repoPath: `/repo/clean-${n}`, agent: null },
      }),
    ];
  }

  it('scores zero for all four when nothing reports checks', () => {
    // A git-only user must never be pushed toward a branch they cannot reach.
    const scores = scoreHabits(commitsAt([10, 11, 12]));
    expect(scores.firefighter).toBe(0);
    expect(scores.refactorer).toBe(0);
    expect(scores.oneShot).toBe(0);
    expect(scores.conjurer).toBe(0);
  });

  it('sends a habitual fixer to Firefighter', () => {
    const events = [...commitsAt([10, 11]), ...Array.from({ length: 12 }, () => fix()).flat()];
    expect(selectBranch(scoreHabits(events))).toBe('firefighter');
  });

  it('sends typecheck and build fixing to Refactorer', () => {
    const events = [
      ...commitsAt([10, 11]),
      ...Array.from({ length: 8 }, () => fix({ kind: 'typecheck' })).flat(),
      ...Array.from({ length: 5 }, () => fix({ kind: 'build' })).flat(),
    ];
    expect(selectBranch(scoreHabits(events))).toBe('refactorer');
  });

  it('sends consistently clean passes to One-Shot', () => {
    const events = [...commitsAt([10, 11]), ...Array.from({ length: 20 }, () => cleanPass()).flat()];
    expect(selectBranch(scoreHabits(events))).toBe('one_shot');
  });

  it('sends agent-assisted fixing to Conjurer', () => {
    const events = [
      ...commitsAt([10, 11]),
      ...Array.from({ length: 10 }, () => fix({ agent: 'claude-code' })).flat(),
    ];
    expect(selectBranch(scoreHabits(events))).toBe('conjurer');
  });

  it('keeps Firefighter and One-Shot as opposites', () => {
    const fixer = scoreHabits(Array.from({ length: 10 }, () => fix()).flat());
    const clean = scoreHabits(Array.from({ length: 10 }, () => cleanPass()).flat());

    expect(fixer.firefighter).toBeGreaterThan(fixer.oneShot);
    expect(clean.oneShot).toBeGreaterThan(clean.firefighter);
  });

  it('will not hand a branch to a single lucky event', () => {
    // Every score is share x volume precisely so one fix cannot win outright.
    const scores = scoreHabits([...commitsAt([2, 2, 2, 2, 2, 2]), ...fix({ agent: 'claude-code' })]);
    expect(selectBranch(scores)).toBe('night_owl');
  });

  it('keeps every score inside 0..1', () => {
    const busy = [
      ...Array.from({ length: 40 }, () => fix({ agent: 'claude-code' })).flat(),
      ...Array.from({ length: 40 }, () => fix({ kind: 'lint' })).flat(),
      ...Array.from({ length: 40 }, () => cleanPass()).flat(),
    ];
    for (const [name, value] of Object.entries(scoreHabits(busy))) {
      expect(value, name).toBeGreaterThanOrEqual(0);
      expect(value, name).toBeLessThanOrEqual(1);
    }
  });
});

describe('evolution', () => {
  /** Enough merges to pass a level, with controllable commit history alongside. */
  function toEvolution(extra: FamiliarEvent[]): FamiliarEvent[] {
    const merges = Math.ceil(totalXpForLevel(EVOLVE_LEVEL) / 40) + 1;
    return [...extra, ...series('pr_merged', merges, {}, new Date('2026-07-20T09:00:00Z'))];
  }

  it('locks a branch once the creature reaches the evolve level', () => {
    const state = deriveState(toEvolution(commitsAt([2, 3, 23, 1, 2, 3])));
    expect(state.level).toBeGreaterThanOrEqual(EVOLVE_LEVEL);
    expect(state.stage).toBe('final');
    expect(state.branch).toBe('night_owl');
    expect(state.evolvedOn).not.toBeNull();
  });

  it('does not re-decide the branch when later habits change', () => {
    const nightHistory = commitsAt([2, 3, 23, 1, 2, 3]);
    const evolved = toEvolution(nightHistory);
    const before = deriveState(evolved);
    expect(before.branch).toBe('night_owl');

    // A huge pile of daytime, test-heavy work arrives afterwards.
    const after = deriveState([
      ...evolved,
      ...series('tests_passed', 60, {}, new Date('2026-07-25T10:00:00Z')),
    ]);
    expect(after.branch).toBe('night_owl');
    expect(after.evolvedOn?.key).toBe(before.evolvedOn?.key);
  });

  it('leaves the branch null before the threshold', () => {
    const state = deriveState(series('commit', 3));
    expect(state.branch).toBeNull();
    expect(state.evolvedOn).toBeNull();
  });
});

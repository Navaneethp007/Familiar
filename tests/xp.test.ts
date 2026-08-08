import { describe, expect, it } from 'vitest';

import { EVENT_TYPES, type EventType } from '../src/core/events.js';
import {
  deriveState,
  EVOLVE_LEVEL,
  HATCH_LEVEL,
  levelForXp,
  MAX_LEVEL,
  stageForLevel,
  totalXpForLevel,
  weeklyTotals,
  XP_TABLE,
} from '../src/core/xp.js';
import { ev, series } from './helpers.js';

describe('the XP table', () => {
  // This is the invariant the whole project exists to protect. If it ever
  // fails, Familiar has become a token-burn tracker.
  it('gives exactly zero XP for using a tool', () => {
    expect(XP_TABLE.tool_used).toBe(0);
    expect(deriveState(series('tool_used', 500)).xp).toBe(0);
    expect(deriveState(series('tool_used', 500)).level).toBe(1);
  });

  it('never awards negative XP for a failing check', () => {
    expect(XP_TABLE.check_failed).toBe(0);
    const withFailures = deriveState([...series('commit', 5), ...series('check_failed', 20)]);
    const withoutFailures = deriveState(series('commit', 5));
    expect(withFailures.xp).toBe(withoutFailures.xp);
  });

  it('scores every flat-rate event type at its documented value', () => {
    // Check observations are excluded on purpose: their worth depends on what
    // came before them, so it cannot live in a table. See transitions.test.ts.
    const flatRate = EVENT_TYPES.filter(
      (t) => !['check_passed', 'check_failed', 'tests_passed', 'tests_failed'].includes(t),
    );
    for (const type of flatRate) {
      expect(deriveState([ev(type)]).xp, type).toBe(XP_TABLE[type]);
    }
  });

  it('gives a bare check observation no flat XP of its own', () => {
    for (const type of ['check_passed', 'check_failed', 'tests_passed', 'tests_failed'] as const) {
      expect(XP_TABLE[type], type).toBe(0);
    }
  });

  it('ranks outcomes above activity', () => {
    expect(XP_TABLE.pr_merged).toBeGreaterThan(XP_TABLE.commit);
    expect(XP_TABLE.commit).toBeGreaterThan(XP_TABLE.session_start);
    expect(XP_TABLE.session_start).toBeGreaterThan(XP_TABLE.tool_used);
  });

  // Every scored event type must be reachable. pr_opened used to sit here worth
  // 15 XP with nothing able to emit it — a promise the engine could not keep,
  // because knowing a PR was opened needs a forge API and nothing here talks to
  // the network.
  it('scores nothing that no adapter can produce', () => {
    const emittable: EventType[] = [
      'session_start',
      'tool_used',
      'commit',
      'pr_merged',
      'check_passed',
      'check_failed',
      'tests_passed',
      'tests_failed',
    ];
    expect(Object.keys(XP_TABLE).sort()).toEqual([...emittable].sort());
  });
});

describe('the level curve', () => {
  it('starts at level 1 for zero XP', () => {
    expect(totalXpForLevel(1)).toBe(0);
    expect(levelForXp(0)).toBe(1);
    expect(levelForXp(-50)).toBe(1);
  });

  it('is strictly increasing', () => {
    for (let level = 2; level <= 40; level++) {
      expect(totalXpForLevel(level)).toBeGreaterThan(totalXpForLevel(level - 1));
    }
  });

  it('round-trips level -> xp -> level', () => {
    for (let level = 1; level <= 40; level++) {
      expect(levelForXp(totalXpForLevel(level))).toBe(level);
      expect(levelForXp(totalXpForLevel(level) - 1)).toBe(level - 1 || 1);
    }
  });

  it('caps at MAX_LEVEL', () => {
    expect(levelForXp(Number.MAX_SAFE_INTEGER)).toBe(MAX_LEVEL);
    expect(deriveState(series('pr_merged', 400)).nextLevelAt).toBeNull();
  });
});

describe('stages', () => {
  it('maps level ranges to egg / hatchling / final', () => {
    expect(stageForLevel(1)).toBe('egg');
    expect(stageForLevel(HATCH_LEVEL - 1)).toBe('egg');
    expect(stageForLevel(HATCH_LEVEL)).toBe('hatchling');
    expect(stageForLevel(EVOLVE_LEVEL - 1)).toBe('hatchling');
    expect(stageForLevel(EVOLVE_LEVEL)).toBe('final');
    expect(stageForLevel(MAX_LEVEL)).toBe('final');
  });
});

describe('deriveState', () => {
  it('ignores repeated keys', () => {
    const once = ev('pr_merged', { key: 'same' });
    const single = deriveState([once]);
    const quadrupled = deriveState([once, once, once, once]);
    expect(quadrupled.xp).toBe(single.xp);
    expect(quadrupled.eventCount).toBe(1);
  });

  it('is order independent', () => {
    const events = [...series('commit', 6), ...series('tests_passed', 3)];
    const forwards = deriveState(events);
    const backwards = deriveState([...events].reverse());
    expect(backwards.xp).toBe(forwards.xp);
    expect(backwards.level).toBe(forwards.level);
  });

  it('reports progress within the current level', () => {
    const state = deriveState(series('commit', 7));
    expect(state.progress).toBeGreaterThanOrEqual(0);
    expect(state.progress).toBeLessThanOrEqual(1);
    expect(state.xp).toBeGreaterThanOrEqual(state.levelFloor);
    if (state.nextLevelAt !== null) expect(state.xp).toBeLessThan(state.nextLevelAt);
  });

  it('counts an empty log as a level 1 egg', () => {
    const state = deriveState([]);
    expect(state.level).toBe(1);
    expect(state.stage).toBe('egg');
    expect(state.branch).toBeNull();
    expect(state.lastEventAt).toBeNull();
  });
});

describe('mood', () => {
  const now = new Date('2026-07-10T12:00:00Z');
  const recently = new Date('2026-07-10T09:00:00Z');

  it('is alarmed right after a failing test run', () => {
    const state = deriveState([ev('tests_failed', { t: recently.toISOString() })], { now });
    expect(state.mood).toBe('alarmed');
  });

  it('is happy right after something lands', () => {
    const state = deriveState([ev('pr_merged', { t: recently.toISOString() })], { now });
    expect(state.mood).toBe('happy');
  });

  it('goes sad after days of silence', () => {
    const state = deriveState([ev('commit', { t: '2026-07-01T09:00:00Z' })], { now });
    expect(state.mood).toBe('sad');
  });
});

describe('weeklyTotals', () => {
  it('counts only the trailing seven days', () => {
    const now = new Date('2026-07-30T12:00:00Z');
    const events = [
      ...series('commit', 3, {}, new Date('2026-07-28T09:00:00Z')),
      ...series('commit', 5, {}, new Date('2026-06-01T09:00:00Z')),
    ];
    expect(weeklyTotals(events, now).commit).toBe(3);
  });
});

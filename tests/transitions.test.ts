import { describe, expect, it } from 'vitest';

import {
  FIRST_GREEN_XP,
  FIX_BASE_XP,
  fixXp,
  foldChecks,
  STALE_RED_MS,
  summariseChecks,
  type CheckKind,
} from '../src/core/checks.js';
import { makeEvent, type FamiliarEvent } from '../src/core/events.js';
import { deriveState } from '../src/core/xp.js';

const START = Date.parse('2026-07-20T10:00:00.000Z');
let seq = 0;

interface CheckOpts {
  kind?: CheckKind;
  repo?: string;
  agent?: string | null;
  minutesLater?: number;
}

/** One check observation. Times advance so ordering and staleness are testable. */
function check(passed: boolean, opts: CheckOpts = {}): FamiliarEvent {
  seq++;
  const at = new Date(START + (opts.minutesLater ?? seq) * 60_000);
  return makeEvent({
    type: passed ? 'check_passed' : 'check_failed',
    source: 'terminal',
    key: `chk:${seq}`,
    at,
    meta: {
      kind: opts.kind ?? 'test',
      repoPath: opts.repo ?? '/repo/a',
      agent: opts.agent === undefined ? null : opts.agent,
    },
  });
}

const xpOf = (events: FamiliarEvent[]): number => deriveState(events).xp;
const summary = (events: FamiliarEvent[]) => summariseChecks(foldChecks(events));

describe('the repetition exploit', () => {
  // The reason this whole module exists. A flat reward per green run meant
  // twenty runs during one debugging session out-earned five merged PRs.
  it('pays nothing for running an already-green check again', () => {
    const first = [check(true)];
    const baseline = xpOf(first);

    const repeated = [...first];
    for (let i = 0; i < 30; i++) repeated.push(check(true));

    expect(xpOf(repeated)).toBe(baseline);
    expect(summary(repeated).redundantGreens).toBe(30);
  });

  it('pays nothing at all for a wall of failures', () => {
    const events: FamiliarEvent[] = [];
    for (let i = 0; i < 25; i++) events.push(check(false));
    expect(xpOf(events)).toBe(0);
  });
});

describe('transitions', () => {
  it('rewards red then green as a fix', () => {
    const events = [check(false), check(true)];
    expect(xpOf(events)).toBe(FIX_BASE_XP);
    expect(summary(events).fixes).toBe(1);
  });

  it('treats a first-ever green as a small win, not a fix', () => {
    const events = [check(true)];
    expect(xpOf(events)).toBe(FIRST_GREEN_XP);
    const s = summary(events);
    expect(s.fixes).toBe(0);
    expect(s.firstGreens).toBe(1);
  });

  it('pays more for a fix that took more attempts', () => {
    const oneTry = xpOf([check(false), check(true)]);
    const threeTries = xpOf([check(false), check(false), check(false), check(true)]);
    expect(threeTries).toBeGreaterThan(oneTry);
  });

  it('caps the struggle bonus', () => {
    expect(fixXp(1)).toBe(FIX_BASE_XP);
    expect(fixXp(50)).toBe(fixXp(4));
    expect(fixXp(0)).toBe(FIX_BASE_XP);
    expect(fixXp(-3)).toBe(FIX_BASE_XP);
  });

  it('records how many attempts the fix took', () => {
    const events = [check(false), check(false), check(true)];
    expect(summary(events).lastFix?.attempts).toBe(2);
  });

  it('starts a fresh attempt count after each fix', () => {
    const events = [check(false), check(false), check(true), check(false), check(true)];
    const s = summary(events);
    expect(s.fixes).toBe(2);
    expect(s.lastFix?.attempts).toBe(1);
  });
});

describe('scope', () => {
  it('keeps repos separate', () => {
    // Breaking repo A and passing repo B is not a fix.
    const events = [check(false, { repo: '/repo/a' }), check(true, { repo: '/repo/b' })];
    expect(summary(events).fixes).toBe(0);
    expect(summary(events).firstGreens).toBe(1);
  });

  it('keeps check kinds separate', () => {
    // A failing typecheck is not fixed by tests passing.
    const events = [check(false, { kind: 'typecheck' }), check(true, { kind: 'test' })];
    expect(summary(events).fixes).toBe(0);
  });

  it('counts a fix when the command changes but the kind does not', () => {
    // Narrowing `npm test` to one failing file is how people actually debug;
    // keying on the exact command would miss nearly every real fix.
    const events = [check(false, { kind: 'test' }), check(true, { kind: 'test' })];
    expect(summary(events).fixes).toBe(1);
  });

  it('tracks each repo and kind independently', () => {
    const events = [
      check(false, { repo: '/repo/a', kind: 'test' }),
      check(false, { repo: '/repo/b', kind: 'lint' }),
      check(true, { repo: '/repo/a', kind: 'test' }),
      check(true, { repo: '/repo/b', kind: 'lint' }),
    ];
    const s = summary(events);
    expect(s.fixes).toBe(2);
    expect(s.fixesByKind.test).toBe(1);
    expect(s.fixesByKind.lint).toBe(1);
  });
});

describe('staleness', () => {
  it('does not count a green as a fix when the red went cold', () => {
    const red = check(false, { minutesLater: 0 });
    const green = check(true, { minutesLater: STALE_RED_MS / 60_000 + 60 });
    const s = summary([red, green]);
    expect(s.fixes).toBe(0);
    expect(s.firstGreens).toBe(1);
  });

  it('still counts a fix within the window', () => {
    const red = check(false, { minutesLater: 0 });
    const green = check(true, { minutesLater: STALE_RED_MS / 60_000 - 60 });
    expect(summary([red, green]).fixes).toBe(1);
  });

  it('measures staleness against event times, not the clock', () => {
    // Replaying an old log must produce the same answer every time.
    const events = [check(false, { minutesLater: 0 }), check(true, { minutesLater: 30 })];
    const a = summary(events);
    const b = summary(events);
    expect(a.fixes).toBe(1);
    expect(b.fixes).toBe(a.fixes);
  });
});

describe('agent attribution', () => {
  it('marks fixes reached alongside an agent', () => {
    const events = [check(false), check(true, { agent: 'claude-code' })];
    const s = summary(events);
    expect(s.fixes).toBe(1);
    expect(s.fixesWithAgent).toBe(1);
  });

  it('does not mark solo fixes', () => {
    expect(summary([check(false), check(true)]).fixesWithAgent).toBe(0);
  });

  it('ignores an unrecognised agent name rather than trusting it', () => {
    const events = [check(false), check(true, { agent: 'definitely-a-real-agent' })];
    expect(summary(events).fixesWithAgent).toBe(0);
  });

  // Attribution changes which branch you evolve down; it must never change
  // how much a fix is worth, or "use the agent more" becomes an XP strategy.
  it('pays exactly the same either way', () => {
    const solo = xpOf([check(false), check(true)]);
    const paired = xpOf([check(false), check(true, { agent: 'claude-code' })]);
    expect(paired).toBe(solo);
  });
});

describe('legacy events', () => {
  it('reads tests_passed / tests_failed as test-kind observations', () => {
    const events = [
      makeEvent({
        type: 'tests_failed',
        source: 'claude-code',
        key: 'old:1',
        at: new Date(START),
        meta: { repoPath: '/repo/a' },
      }),
      makeEvent({
        type: 'tests_passed',
        source: 'claude-code',
        key: 'old:2',
        at: new Date(START + 60_000),
        meta: { repoPath: '/repo/a' },
      }),
    ];
    const s = summary(events);
    expect(s.fixes).toBe(1);
    expect(s.fixesByKind.test).toBe(1);
  });

  it('lets an old failure be fixed by a new-style observation', () => {
    const events = [
      makeEvent({
        type: 'tests_failed',
        source: 'claude-code',
        key: 'old:3',
        at: new Date(START),
        meta: { repoPath: '/repo/a', kind: 'test' },
      }),
      check(true, { repo: '/repo/a', kind: 'test', minutesLater: 10 }),
    ];
    expect(summary(events).fixes).toBe(1);
  });
});

describe('integration with the level curve', () => {
  it('surfaces the check summary on derived state', () => {
    const state = deriveState([check(false), check(true), check(true)]);
    expect(state.checks.fixes).toBe(1);
    expect(state.checks.failures).toBe(1);
    // The third observation is green-on-green: counted, but worth nothing.
    expect(state.checks.redundantGreens).toBe(1);
  });

  it('lets a fix trigger a level-up', () => {
    const before = deriveState([check(false)]);
    const after = deriveState([check(false), check(true)]);
    expect(after.xp).toBeGreaterThan(before.xp);
    expect(after.level).toBeGreaterThanOrEqual(before.level);
  });

  it('stays deterministic across repeated derivation', () => {
    const events = [check(false), check(true), check(false), check(false), check(true)];
    const first = deriveState(events);
    for (let i = 0; i < 5; i++) {
      expect(deriveState(events).xp).toBe(first.xp);
    }
  });
});

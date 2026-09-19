import { describe, expect, it } from 'vitest';

import {
  countChecksIn,
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

describe('a slot going green cold for the first time', () => {
  // `minutesLater` is an absolute offset from START, not a delta, so both ends
  // of a gap have to be pinned — otherwise the default `seq` counter decides
  // the spacing and the gap is whatever the test order happens to make it.
  const AT_ZERO = { minutesLater: 0 } as const;
  const STALE_MINUTES = STALE_RED_MS / 60_000 + 60;

  it('records the first green, with the event that caused it', () => {
    const events = [check(true)];
    const result = summary(events);
    expect(result.coldFirstGreens).toBe(1);
    expect(result.lastColdGreen?.repoPath).toBe('/repo/a');
    expect(result.lastColdGreen?.kind).toBe('test');
    expect(result.lastColdGreen?.eventKey).toBe(events[0]?.key);
  });

  it('does not fire again for the same slot, however many greens follow', () => {
    const events = [check(true)];
    for (let i = 0; i < 30; i++) events.push(check(true));
    const result = summary(events);
    expect(result.coldFirstGreens).toBe(1);
    expect(result.redundantGreens).toBe(30);
  });

  // The entire reason this exists as a separate counter. `firstGreens` is a
  // rhythm — it recurs after every idle day. This is a milestone.
  it('does not fire again after a stale gap, even though firstGreens does', () => {
    const events = [check(true, AT_ZERO), check(true, { minutesLater: STALE_MINUTES })];
    const result = summary(events);
    expect(result.firstGreens).toBe(2);
    expect(result.coldFirstGreens).toBe(1);
  });

  it('counts a slot that was only ever red before, once it finally goes green', () => {
    const events = [check(false, AT_ZERO), check(true, { minutesLater: STALE_MINUTES })];
    const result = summary(events);
    // Stale, so not scored as a fix — but it is genuinely the first green here.
    expect(result.fixes).toBe(0);
    expect(result.coldFirstGreens).toBe(1);
  });

  it('does not count a red that was fixed promptly — that is a fix, not a first', () => {
    const result = summary([check(false), check(true)]);
    expect(result.fixes).toBe(1);
    expect(result.coldFirstGreens).toBe(0);
  });

  // The sharp edge of the name. A slot whose first green arrived as a fix is
  // marked green forever, so it can never produce a cold green later — even
  // after a stale gap that would otherwise qualify. Deliberate: the fix already
  // got its own line, and saying it twice reads as not paying attention.
  it('never counts a slot whose first green arrived as a fix, however long it then idles', () => {
    const result = summary([
      check(false, AT_ZERO),
      check(true, { minutesLater: 5 }),
      check(true, { minutesLater: STALE_MINUTES }),
    ]);
    expect(result.fixes).toBe(1);
    expect(result.firstGreens).toBe(1);
    expect(result.coldFirstGreens).toBe(0);
  });

  it('keys on repo and kind, like every other transition', () => {
    expect(summary([check(true, { repo: '/a' }), check(true, { repo: '/b' })]).coldFirstGreens).toBe(2);
    expect(
      summary([check(true, { kind: 'test' }), check(true, { kind: 'lint' })]).coldFirstGreens,
    ).toBe(2);
  });

  it('changes no XP at all', () => {
    expect(xpOf([check(true)])).toBe(FIRST_GREEN_XP);
    // A stale re-green still pays the small first-green nudge, exactly as before.
    expect(xpOf([check(true, AT_ZERO), check(true, { minutesLater: STALE_MINUTES })])).toBe(
      2 * FIRST_GREEN_XP,
    );
    expect(xpOf([check(false), check(true)])).toBe(FIX_BASE_XP);
  });

  it('stays deterministic', () => {
    const events = [check(true), check(false), check(true), check(true, { repo: '/b' })];
    const first = foldChecks(events).coldGreenRecords;
    for (let i = 0; i < 5; i++) {
      expect(foldChecks(events).coldGreenRecords).toEqual(first);
    }
  });
});

describe('first greens as records', () => {
  it('records one per first green, matching the count', () => {
    const events = [check(true), check(true, { repo: '/repo/b' }), check(true, { kind: 'lint' })];
    const result = foldChecks(events);
    expect(result.firstGreenRecords).toHaveLength(result.firstGreens);
    expect(result.firstGreens).toBe(3);
  });

  it('carries where and when each one happened', () => {
    const green = check(true, { kind: 'build', repo: '/repo/z', agent: 'claude-code' });
    const [record] = foldChecks([green]).firstGreenRecords;
    expect(record?.kind).toBe('build');
    expect(record?.repoPath).toBe('/repo/z');
    expect(record?.agent).toBe('claude-code');
    expect(record?.eventKey).toBe(green.key);
    expect(record?.at).toBe(Date.parse(green.t));
  });

  it('counts a fix as a fix, never as a first green', () => {
    const result = foldChecks([check(false), check(true)]);
    expect(result.firstGreenRecords).toHaveLength(0);
    expect(result.fixes).toHaveLength(1);
  });

  // coldGreenRecords fires once per slot ever; firstGreens recurs after each
  // staleness gap. The first can therefore never stand in for the second.
  it('is a superset of the cold greens', () => {
    const events = [
      check(true),
      check(true, { minutesLater: 60 * 48 }),
      check(true, { repo: '/repo/b' }),
    ];
    const result = foldChecks(events);
    const first = new Set(result.firstGreenRecords.map((r) => r.eventKey));
    for (const cold of result.coldGreenRecords) expect(first.has(cold.eventKey)).toBe(true);
    expect(result.firstGreenRecords.length).toBeGreaterThan(result.coldGreenRecords.length);
  });
});

describe('counting checks inside a window', () => {
  const keysOf = (events: readonly FamiliarEvent[]): Set<string> =>
    new Set(events.map((e) => e.key));

  /**
   * The test this whole design exists for.
   *
   * `foldChecks` carries per-slot state across events, so folding a SUFFIX
   * reclassifies: a green whose red fell before the window looks like a first
   * green, and a green on an already-green slot looks like one too. Both move
   * score from firefighter to one_shot, which are exact complements on their
   * share term. Filtering a whole-log fold keeps the classification the full
   * history gave it.
   */
  it('keeps the classification the whole log gave, where folding a slice would not', () => {
    const red = check(false);
    const fixed = check(true);
    const otherRepo = check(true, { repo: '/repo/b' });
    const again = check(true);
    const all = [red, fixed, otherRepo, again];
    const window = [otherRepo, again];

    const windowed = countChecksIn(foldChecks(all), keysOf(window));
    expect(windowed.fixes).toBe(0);
    expect(windowed.firstGreens).toBe(1);

    // What the naive approach would have said, and why it is wrong: the repeat
    // green on /repo/a becomes a second "first green".
    const naive = summariseChecks(foldChecks(window));
    expect(naive.firstGreens).toBe(2);
    expect(naive.firstGreens).not.toBe(windowed.firstGreens);
  });

  it('keeps a fix a fix when only its green is inside the window', () => {
    const red = check(false);
    const green = check(true);
    const windowed = countChecksIn(foldChecks([red, green]), keysOf([green]));
    expect(windowed.fixes).toBe(1);
    expect(windowed.firstGreens).toBe(0);
    expect(summariseChecks(foldChecks([green])).fixes).toBe(0);
  });

  it('agrees with the full summary when the window is everything', () => {
    const events = [
      check(false),
      check(true),
      check(true, { repo: '/repo/b', agent: 'claude-code' }),
      check(false, { kind: 'lint' }),
      check(true, { kind: 'lint' }),
    ];
    const result = foldChecks(events);
    const whole = summariseChecks(result);
    const windowed = countChecksIn(result, keysOf(events));
    expect(windowed.fixes).toBe(whole.fixes);
    expect(windowed.firstGreens).toBe(whole.firstGreens);
    expect(windowed.fixesWithAgent).toBe(whole.fixesWithAgent);
    expect(windowed.fixesByKind).toEqual(whole.fixesByKind);
  });

  it('counts nothing for an empty window', () => {
    const result = foldChecks([check(false), check(true)]);
    const windowed = countChecksIn(result, new Set<string>());
    expect(windowed.fixes).toBe(0);
    expect(windowed.firstGreens).toBe(0);
    expect(windowed.fixesByKind).toEqual({ test: 0, build: 0, typecheck: 0, lint: 0 });
  });

  it('splits fixes by kind and agent inside the window', () => {
    const early = [check(false, { kind: 'lint' }), check(true, { kind: 'lint' })];
    const late = [
      check(false, { kind: 'build', agent: 'claude-code' }),
      check(true, { kind: 'build', agent: 'claude-code' }),
    ];
    const windowed = countChecksIn(foldChecks([...early, ...late]), keysOf(late));
    expect(windowed.fixes).toBe(1);
    expect(windowed.fixesWithAgent).toBe(1);
    expect(windowed.fixesByKind.build).toBe(1);
    expect(windowed.fixesByKind.lint).toBe(0);
  });
});

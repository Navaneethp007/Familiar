import { describe, expect, it } from 'vitest';

import { foldChecks } from '../src/core/checks.js';
import { makeEvent, type FamiliarEvent } from '../src/core/events.js';
import { scoreHabits, selectBranch, type HabitScores } from '../src/core/habits.js';
import {
  calibrateWindow,
  challengerFor,
  findReevolution,
  habitBearingKeys,
  NIGHT_OWL_MIN_COMMITS,
  REEVOLVE_LEVEL,
  REEVOLVE_MARGIN,
  REEVOLVE_WINDOW_MAX,
  REEVOLVE_WINDOW_MIN,
  windowedHabits,
} from '../src/core/reevolve.js';

const START = Date.parse('2026-01-01T09:00:00.000Z');
let seq = 0;

/** Events land a minute apart so order is unambiguous and nothing goes stale. */
function at(): Date {
  seq++;
  return new Date(START + seq * 60_000);
}

function commits(n: number, hour = 14): FamiliarEvent[] {
  return Array.from({ length: n }, () =>
    makeEvent({ type: 'commit', source: 'git', key: `c:${seq}`, at: at(), meta: { hour } }),
  );
}

function merges(n: number): FamiliarEvent[] {
  return Array.from({ length: n }, () =>
    makeEvent({ type: 'pr_merged', source: 'git', key: `m:${seq}`, at: at(), meta: { hour: 14 } }),
  );
}

/** `n` red→green pairs, each one a fix. Distinct slots keep them independent. */
function fixes(n: number, opts: { agent?: string | null; kind?: string } = {}): FamiliarEvent[] {
  const out: FamiliarEvent[] = [];
  for (let i = 0; i < n; i++) {
    const meta = {
      kind: opts.kind ?? 'test',
      repoPath: `/repo/${seq}`,
      agent: opts.agent === undefined ? null : opts.agent,
    };
    out.push(makeEvent({ type: 'check_failed', source: 'terminal', key: `f:${seq}`, at: at(), meta }));
    out.push(makeEvent({ type: 'check_passed', source: 'terminal', key: `p:${seq}`, at: at(), meta }));
  }
  return out;
}

/** Greens on fresh slots — first greens, the one-shot signal. */
function cleanPasses(n: number): FamiliarEvent[] {
  return Array.from({ length: n }, () =>
    makeEvent({
      type: 'check_passed',
      source: 'terminal',
      key: `g:${seq}`,
      at: at(),
      meta: { kind: 'test', repoPath: `/clean/${seq}` },
    }),
  );
}

const score = (events: FamiliarEvent[]): HabitScores => scoreHabits(events);
const topOf = (events: FamiliarEvent[]) => selectBranch(score(events));

/** A familiar whose recent work is overwhelmingly agent-assisted repair. */
const conjurerTail = () => fixes(60, { agent: 'claude-code' });

describe('habit-bearing events', () => {
  it('counts the things that say who you are, and nothing else', () => {
    const events = [
      ...commits(3),
      ...merges(2),
      ...fixes(2),
      ...cleanPasses(1),
      makeEvent({ type: 'tool_used', source: 'claude-code', key: 'tool', at: at(), meta: {} }),
      makeEvent({ type: 'session_start', source: 'claude-code', key: 'sess', at: at(), meta: {} }),
    ];
    const keys = new Set(habitBearingKeys(events, foldChecks(events)));

    // 3 commits + 2 merges + 2 fixes + 1 first green.
    expect(keys.size).toBe(8);
    expect(keys.has('tool')).toBe(false);
    expect(keys.has('sess')).toBe(false);
    // A red is evidence of nothing on its own — only the transition counts.
    expect([...keys].some((k) => k.startsWith('f:'))).toBe(false);
  });

  it('ignores a green that changed nothing', () => {
    const meta = { kind: 'test', repoPath: '/repo/same' };
    const first = makeEvent({ type: 'check_passed', source: 'terminal', key: 'g1', at: at(), meta });
    const again = makeEvent({ type: 'check_passed', source: 'terminal', key: 'g2', at: at(), meta });
    const events = [first, again];
    expect(habitBearingKeys(events, foldChecks(events))).toEqual(['g1']);
  });
});

describe('calibrating the window', () => {
  it('is the evidence the first evolution had', () => {
    const head = [...commits(40), ...merges(40)];
    const marker = head[head.length - 1]!;
    const events = [...head, ...conjurerTail()];
    expect(calibrateWindow(events, foldChecks(events), marker.key)).toBe(80);
  });

  it('never drops below the floor', () => {
    const head = commits(5);
    const events = [...head, ...conjurerTail()];
    const n = calibrateWindow(events, foldChecks(events), head[4]!.key);
    expect(n).toBe(REEVOLVE_WINDOW_MIN);
  });

  it('never rises above the ceiling', () => {
    const head = commits(REEVOLVE_WINDOW_MAX + 50);
    const events = [...head, ...conjurerTail()];
    const n = calibrateWindow(events, foldChecks(events), head[head.length - 1]!.key);
    expect(n).toBe(REEVOLVE_WINDOW_MAX);
  });

  it('gives nothing for an event the log no longer holds', () => {
    const events = commits(80);
    expect(calibrateWindow(events, foldChecks(events), 'vanished')).toBeNull();
  });
});

describe('the window itself', () => {
  it('refuses a log that cannot fill it', () => {
    const events = commits(10);
    expect(windowedHabits(events, foldChecks(events), 60)).toBeNull();
  });

  it('scores the tail, not the whole life', () => {
    const events = [...commits(100, 2), ...conjurerTail()];
    const windowed = windowedHabits(events, foldChecks(events), 60);
    expect(windowed).not.toBeNull();
    expect(selectBranch(windowed!.scores)).toBe('conjurer');
    // All-time, the hundred night commits still dominate.
    expect(topOf(events)).toBe('night_owl');
  });

  /**
   * The premise of the whole feature, pinned as a direction rather than a
   * number. `saturate` uses halfway points of 4, 6 and 8, so once counts reach
   * the hundreds every habit sits near 1.0 and the margins collapse — measured
   * on a real log, a 0.17 margin at evolution had become 0.07 all-time. If a
   * window ever stops separating better than the whole log, this feature has
   * lost its reason to exist.
   */
  it('separates better than the whole log does', () => {
    const events = [...commits(120, 2), ...merges(120), ...fixes(120), ...conjurerTail()];
    const gap = (scores: HabitScores): number => {
      const ranked = Object.values(scores).sort((a, b) => b - a);
      return (ranked[0] ?? 0) - (ranked[1] ?? 0);
    };
    const windowed = windowedHabits(events, foldChecks(events), 60);
    expect(gap(windowed!.scores)).toBeGreaterThan(gap(score(events)));
  });

  /**
   * `speed` is half `saturate(commits per active day, 6)`, and a shorter window
   * has fewer active days, which raises it. The other half is
   * `saturate(merges, 4)`, which falls much harder. The net must not hand out
   * Speed Demon for free.
   */
  it('does not hand a familiar speed_demon just for being windowed', () => {
    const events = [...merges(150), ...conjurerTail()];
    const windowed = windowedHabits(events, foldChecks(events), 60);
    expect(topOf(events)).not.toBe('speed_demon');
    expect(selectBranch(windowed!.scores)).not.toBe('speed_demon');
  });
});

describe('the challenger', () => {
  const scores = (over: Partial<HabitScores>): HabitScores => ({
    night: 0,
    test: 0,
    speed: 0,
    firefighter: 0,
    refactorer: 0,
    oneShot: 0,
    conjurer: 0,
    ...over,
  });

  it('needs to clear the margin, not merely lead', () => {
    const short = scores({ conjurer: 0.5 + REEVOLVE_MARGIN - 0.001, night: 0.5 });
    expect(challengerFor(short, 'night_owl')).toBeNull();

    const enough = scores({ conjurer: 0.5 + REEVOLVE_MARGIN, night: 0.5 });
    expect(challengerFor(enough, 'night_owl')?.branch).toBe('conjurer');
  });

  it('measures the gap against the incumbent, not the runner-up', () => {
    const s = scores({ conjurer: 0.9, firefighter: 0.88, night: 0.2 });
    expect(challengerFor(s, 'night_owl')?.margin).toBeCloseTo(0.7, 5);
  });

  it('never challenges with the incumbent itself', () => {
    expect(challengerFor(scores({ night: 0.9 }), 'night_owl')).toBeNull();
  });

  it('leaves a tie to the incumbent', () => {
    expect(challengerFor(scores({ night: 0.8, conjurer: 0.8 }), 'night_owl')).toBeNull();
    expect(challengerFor(scores({ night: 0.8, conjurer: 0.8 }), 'conjurer')).toBeNull();
  });
});

describe('deciding a second evolution', () => {
  const base = (events: FamiliarEvent[], over: Record<string, unknown> = {}) => ({
    events,
    level: REEVOLVE_LEVEL,
    branch: 'night_owl' as const,
    firstEventKey: events[0]!.key,
    alreadyReevolved: false,
    ...over,
  });

  const changed = () => [...commits(80, 2), ...conjurerTail()];

  it('fires when recent work no longer matches the branch', () => {
    const events = changed();
    const found = findReevolution(base(events));
    expect(found?.branch).toBe('conjurer');
    expect(found?.from).toBe('night_owl');
    expect(found?.margin).toBeGreaterThanOrEqual(REEVOLVE_MARGIN);
    expect(found?.eventKey).toBe(events[events.length - 1]!.key);
  });

  it('is deterministic', () => {
    const events = changed();
    const runs = Array.from({ length: 5 }, () => findReevolution(base(events))?.branch);
    expect(new Set(runs).size).toBe(1);
  });

  it('waits for the level floor', () => {
    expect(findReevolution(base(changed(), { level: REEVOLVE_LEVEL - 1 }))).toBeNull();
  });

  // The floor has no ceiling: this is the one real event left past the cap.
  it('still fires long after the last level', () => {
    expect(findReevolution(base(changed(), { level: 100 }))?.branch).toBe('conjurer');
  });

  it('happens once in a lifetime', () => {
    expect(findReevolution(base(changed(), { alreadyReevolved: true }))).toBeNull();
  });

  it('stays quiet when the branch still fits', () => {
    const events = [...commits(80, 2), ...commits(80, 3)];
    expect(findReevolution(base(events))).toBeNull();
  });

  it('refuses when the log cannot fill the window', () => {
    const events = [...commits(5, 2), ...fixes(4, { agent: 'claude-code' })];
    expect(findReevolution(base(events))).toBeNull();
  });

  it('refuses when the first evolution cannot be located at all', () => {
    const events = commits(10, 2);
    expect(findReevolution(base(events, { firstEventKey: 'gone' }))).toBeNull();
  });

  /**
   * The incumbent needs to be able to defend itself. The four check-dependent
   * branches score zero with no check evidence in the window, so a user who
   * uninstalls the shell integration would be beaten by anything at all — and
   * that is a tooling change, not a person changing.
   */
  it('refuses to unseat a check-dependent branch on a window with no checks', () => {
    const events = [...fixes(80, { agent: 'claude-code' }), ...commits(80, 2)];
    const input = base(events, { branch: 'conjurer' as const });
    expect(findReevolution(input)).toBeNull();
  });

  /**
   * `night` is the only habit with no volume term — a bare ratio. Twelve
   * commits, all after 22:00, scores 1.0 outright, which would make Night Owl
   * the likeliest second evolution for a large class of users on almost no
   * evidence.
   */
  it('refuses night_owl without real commit volume behind it', () => {
    // A window of mostly fixes with a handful of 2am commits: night scores 1.0
    // on twelve commits and would walk it.
    const thin = [...fixes(100), ...commits(NIGHT_OWL_MIN_COMMITS - 8, 2)];
    const input = base(thin, { branch: 'test_guardian' as const, firstEventKey: thin[0]!.key });
    expect(findReevolution(input)).toBeNull();
  });

  it('allows night_owl once the commits are there', () => {
    const thick = [...fixes(100), ...commits(NIGHT_OWL_MIN_COMMITS + 5, 2)];
    const input = base(thick, { branch: 'test_guardian' as const, firstEventKey: thick[0]!.key });
    expect(findReevolution(input)?.branch).toBe('night_owl');
  });

  it('reports the window it used', () => {
    const events = changed();
    expect(findReevolution(base(events))?.window).toBe(REEVOLVE_WINDOW_MIN);
  });
});

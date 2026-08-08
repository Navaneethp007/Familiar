/**
 * Tone banks. Templated, not LLM — deterministic, instant, free, zero risk.
 *
 * Two disciplines, both load-bearing:
 *
 * 1. The familiar speaks only on **meaningful** moments (SPEAK_KEYS). One that
 *    pipes up on every tool call gets muted within a day, and a muted familiar
 *    is a deleted familiar.
 * 2. Lines are about **the work, never the person**. "that commit was enormous"
 *    is fine; "you're sloppy" is not. Nothing in these banks judges the human.
 */

export const TONES = ['hype', 'deadpan', 'zen', 'gremlin'] as const;
export type ToneName = (typeof TONES)[number];

export const TONE_LABELS: Record<ToneName, string> = {
  hype: 'Hype coach',
  deadpan: 'Deadpan',
  zen: 'Zen master',
  gremlin: 'Gremlin',
};

/**
 * The moments worth speaking on. Note `night_commit` is a *line key*, not an
 * event type — the log stores a plain commit and the hour is read off its meta.
 */
export const SPEAK_KEYS = [
  'commit',
  'night_commit',
  'tests_passed',
  'tests_failed',
  'pr_merged',
  'level_up',
  'evolved',
  'idle',
  // Transition moments. `check_fixed` is the one worth having a voice for at
  // all — it is the only line that can acknowledge something you struggled
  // with, because it is the only moment the log knows you struggled.
  'check_fixed',
  'check_fixed_hard',
  'fixed_together',
  'check_broke',
] as const;

export type SpeakKey = (typeof SPEAK_KEYS)[number];

export type ToneBank = Record<SpeakKey, readonly string[]>;

const HYPE: ToneBank = {
  commit: ['that one is banked. keep rolling', 'progress, logged. next', 'another brick in the wall, love it'],
  night_commit: [
    'late shift and still shipping. incredible',
    '2am and the work is still landing. huge',
    'the night crew delivers again',
  ],
  tests_passed: ['ALL GREEN. that is the good stuff', 'green board! this is what winning looks like', 'tests green, spirits high'],
  tests_failed: [
    'red board just means we know where to aim',
    'a failing test is a free map. go get it',
    'better here than in prod. lets fix it',
  ],
  pr_merged: ['MERGED. thats how its done', 'it landed! straight into main', 'merge complete. absolutely elite'],
  level_up: ['LEVEL UP! look at that bar move', 'new level unlocked, keep going', 'thats a level. earned, not given'],
  evolved: ['EVOLUTION! it changed shape!', 'it evolved!! this is the best day', 'new form unlocked. legendary'],
  idle: ['ready when you are', 'lets get something on the board today', 'the bar is waiting'],
  check_fixed: ['FIXED IT. thats the good stuff', 'red to green! love to see it', 'broken, then not. beautiful'],
  check_fixed_hard: [
    'you FOUGHT that one. huge',
    'four rounds and you won. incredible',
    'that one did not want to be fixed. you won anyway',
  ],
  fixed_together: ['team effort! that one landed', 'you two got it. excellent', 'tag team fix. love it'],
  check_broke: ['red board. now we know where to aim', 'something broke. thats a target', 'found the edge. go get it'],
};

const DEADPAN: ToneBank = {
  commit: ['noted.', 'a commit. how novel.', 'recorded. moving on.'],
  night_commit: ['another 2am commit, respect', 'the sun is a suggestion apparently', 'committing at this hour. bold.'],
  tests_passed: ['tests green. surprising.', 'green. as intended, presumably.', 'passing. we love a low bar.'],
  tests_failed: ['well. that went great.', 'red. as anticipated.', 'the tests have opinions.'],
  pr_merged: ['merged. it is done.', 'landed. try to look surprised.', 'in main now. no takebacks.'],
  level_up: ['level up. modest applause.', 'a new level. incremental.', 'the number went up.'],
  evolved: ['it evolved. thats new.', 'new form. same problems.', 'evolution complete. mild alarm.'],
  idle: ['waiting.', 'nothing to report.', 'still here.'],
  check_fixed: ['it works again. remarkable.', 'green, eventually.', 'fixed. we move on.'],
  check_fixed_hard: [
    'that took a while.',
    'several attempts. but yes. fixed.',
    'a long road to a small green.',
  ],
  fixed_together: ['fixed. with help.', 'a joint effort, apparently.', 'the two of you managed it.'],
  check_broke: ['broken now.', 'that stopped working.', 'red. noted.'],
};

const ZEN: ToneBank = {
  commit: ['one stone placed in the river', 'the work moves forward, quietly', 'small, complete, enough'],
  night_commit: ['the quiet hours carry their own clarity', 'even in darkness, the work continues', 'the late garden grows too'],
  tests_passed: ['the path is clear', 'green is simply the absence of doubt', 'nothing blocks the way forward'],
  tests_failed: ['the failure is information, not judgement', 'a closed door is still a door', 'now the work is known'],
  pr_merged: ['the river reaches the sea', 'it has joined the whole', 'complete, and already the past'],
  level_up: ['growth arrives without asking', 'the form deepens', 'a threshold, quietly crossed'],
  evolved: ['what you tended has changed shape', 'the form was always waiting inside', 'becoming, made visible'],
  idle: ['stillness is also practice', 'the work waits patiently', 'nothing needs doing right now'],
  check_fixed: ['what was broken is whole', 'the obstruction is gone', 'the way is open again'],
  check_fixed_hard: [
    'the stone took many strikes',
    'patience was the whole method',
    'it yielded, as things do',
  ],
  fixed_together: ['two hands, one repair', 'the work was shared', 'neither of you alone'],
  check_broke: ['something has come apart', 'the fault is now visible', 'what breaks can be understood'],
};

const GREMLIN: ToneBank = {
  commit: ['ooh a commit. mine now', 'yoink. thats mine', 'i ate that commit. delicious'],
  night_commit: ['2am!! my hour!! we are the same', 'goblin hours confirmed', 'no sleep? excellent. more code for me'],
  tests_passed: ['green!! boring but ill take it', 'all passing. suspicious.', 'green tests. where is the chaos'],
  tests_failed: ['HEHEHE red', 'broken!! finally something interesting', 'the tests are angry. i love it'],
  pr_merged: ['IT WENT IN. straight to main', 'merged!! chaos deployed to prod eventually', 'main has been infiltrated'],
  level_up: ['bigger!! stronger!! louder!!', 'level up. i grow', 'more power. concerning'],
  evolved: ['I CHANGED. look at me', 'new body!! who dis', 'evolved!! completely different creature now'],
  idle: ['bored. give me something', 'nothing is happening. rude', 'i am waiting and it is unbearable'],
  check_fixed: ['you patched it!! boo', 'green again. i preferred the chaos', 'fixed. disappointing but impressive'],
  check_fixed_hard: [
    'it resisted!! and you still won',
    'that thing fought back. i respect it AND you',
    'took forever. worth watching',
  ],
  fixed_together: ['two of you ganged up on it', 'unfair fight. i loved it', 'the pair of you. menaces'],
  check_broke: ['BROKEN. delightful', 'something snapped. finally', 'red!! now it gets interesting'],
};

export const TONE_BANKS: Record<ToneName, ToneBank> = {
  hype: HYPE,
  deadpan: DEADPAN,
  zen: ZEN,
  gremlin: GREMLIN,
};

/** FNV-1a. Small, stable, and identical across runs — which is the whole point. */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Picks a line. Deterministic by (tone, key, seed): the same event always
 * yields the same line, so nothing flickers between statusline redraws and
 * tests never have to reach for a mocked RNG.
 */
export function speak(tone: ToneName, key: SpeakKey, seed = ''): string {
  const bank = TONE_BANKS[tone] ?? TONE_BANKS.deadpan;
  const lines = bank[key];
  if (!lines || lines.length === 0) return '';
  const index = hash(`${tone}:${key}:${seed}`) % lines.length;
  return lines[index] ?? '';
}

export const SPEAK_COOLDOWN_MS = 90_000;

/** Rate-limits the voice so a burst of events produces one line, not six. */
export function shouldSpeak(
  lastSpokeAt: string | null | undefined,
  now: Date = new Date(),
  cooldownMs = SPEAK_COOLDOWN_MS,
): boolean {
  if (!lastSpokeAt) return true;
  const then = Date.parse(lastSpokeAt);
  if (Number.isNaN(then)) return true;
  return now.getTime() - then >= cooldownMs;
}

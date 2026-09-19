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
  // The second and last evolution, decided late in life on recent work rather
  // than on a threshold. No line here may name a branch or imply a previous
  // form: the shape it replaced is meant to leave no trace. See
  // core/reevolve.ts.
  'reevolved',
  'idle',
  // Ambient at the cap. Like `idle`, never returned by chooseSpeakKey — the
  // surfaces pick it themselves, on a clock, because there is no event to
  // react to. It is the only line most capped familiars will ever say.
  'at_peace',
  // The end of the ladder, said once.
  'max_level',
  // Landmarks on cumulative counts. See core/milestones.ts.
  'milestone_commits',
  'milestone_merges',
  'milestone_fixes',
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
  reevolved: [
    'IT CHANGED AGAIN. after all this time',
    'a whole new shape. you earned that twice',
    'second evolution!! nobody sees these',
  ],
  idle: ['ready when you are', 'lets get something on the board today', 'the bar is waiting'],
  at_peace: [
    'the bar is done. the work is not',
    'still shipping at the ceiling. thats the flex',
    'no levels left, so its just you and the craft now',
    'peak form. and still showing up. love it',
    'nothing left to earn. everything left to build',
    'the grind ended. the good part didnt',
    'top of the ladder, still doing reps',
    'max level and still here. thats the whole point',
  ],
  max_level: [
    'THE CAP. you actually did it',
    'thats the ceiling. the bar is done, you are not',
    'MAX LEVEL. nothing left to climb. incredible',
  ],
  milestone_commits: [
    'that is a LOT of commits. look at the pile',
    'the commit count just hit a real number',
    'a stack of work that high is no accident',
  ],
  milestone_merges: [
    'that many merges is a serious record',
    'another landmark landed. elite numbers',
    'the merge count is getting ridiculous',
  ],
  milestone_fixes: [
    'that many saves is a record, not a streak',
    'the fix count just hit a landmark. huge',
    'red to green, again and again. elite',
  ],
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
  reevolved: [
    'it changed again. that is rarer.',
    'a different shape entirely. noted.',
    'second evolution. genuinely unusual.',
  ],
  idle: ['waiting.', 'nothing to report.', 'still here.'],
  at_peace: [
    'the bar retired. i did not.',
    'no more levels. same desk, same work.',
    'maxed out. still watching, obviously.',
    'nothing left to measure. carry on.',
    'the numbers ended. the commits did not.',
    'at the ceiling. it is quite nice up here.',
    'no progress bar. surprisingly freeing.',
    'finished the game. still turning up.',
  ],
  max_level: [
    'the numbers stop here.',
    'thats the last level. the game is finished.',
    'max level. the bar retires, i do not.',
  ],
  milestone_commits: [
    'the commit count reached a round number.',
    'a milestone. numerically speaking.',
    'that is a great many commits. noted.',
  ],
  milestone_merges: [
    'the merge count hit a landmark. impressive.',
    'a notable number of merges. carry on.',
    'that is a lot of things in main now.',
  ],
  milestone_fixes: [
    'a landmark number of things un-broken.',
    'the fix count reached a round number.',
    'many repairs. all of them counted.',
  ],
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
  reevolved: [
    'what you became, you have become again',
    'the shape followed the work, once more',
    'nothing stays finished for long',
  ],
  idle: ['stillness is also practice', 'the work waits patiently', 'nothing needs doing right now'],
  at_peace: [
    'nothing left to climb. only to tend',
    'the ladder ended. the garden did not',
    'arrival is not an ending',
    'the work needs no number to be real',
    'past the last threshold, the path widens',
    'complete, and still continuing',
    'there is nowhere left to get to',
    'the measure fell away. the practice remains',
  ],
  max_level: [
    'the ladder ends here. the practice does not',
    'you have arrived. now simply continue',
    'the last threshold, quietly crossed',
  ],
  milestone_commits: [
    'many small stones, now a wall',
    'the count passed a quiet landmark',
    'each one was small. together, not',
  ],
  milestone_merges: [
    'many rivers have reached the sea',
    'the whole is made of all of these',
    'a landmark, passed without stopping',
  ],
  milestone_fixes: [
    'many broken things, made whole again',
    'the count of repairs passed a landmark',
    'each repair was small. the sum is not',
  ],
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
  reevolved: [
    'AGAIN?? i have changed AGAIN',
    'new shape!! the old one is gone forever',
    'twice now. i am unrecognisable',
  ],
  idle: ['bored. give me something', 'nothing is happening. rude', 'i am waiting and it is unbearable'],
  at_peace: [
    'i ate all the xp. there is none left',
    'no more levels!! i am free. we are free',
    'maxed out and still causing problems. good',
    'the bar is gone. i live in the footer now',
    'finished the game. staying anyway. suffer',
    'nothing left to grind. pure chaos from here',
    'top level!! now i just watch you type',
    'no numbers left. only me',
  ],
  max_level: [
    'THE LAST ONE!! the bar exploded',
    'max level!! i ate the last of the xp',
    'thats it. no more numbers. only vibes',
  ],
  milestone_commits: [
    'SO MANY COMMITS. i have eaten them all',
    'the pile is enormous now. all mine',
    'a hoard of commits. delicious hoard',
  ],
  milestone_merges: [
    'main has been infiltrated MANY times now',
    'the merge hoard grows. excellent',
    'that many?? outrageous. i love it',
  ],
  milestone_fixes: [
    'that many rescues?? annoyingly impressive',
    'all that un-breaking. it never stops',
    'a landmark pile of repairs. boo',
  ],
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

/**
 * How long an ambient line holds.
 *
 * Both bounds are real. Below a minute it would visibly change while somebody
 * is reading it — Claude Code redraws the statusline on every assistant
 * message — which is flicker, not life. It also has to sit clearly slower than
 * the event band (QUIP_TTL_MS 5min, SPEAK_COOLDOWN_MS 90s) so a real quip still
 * reads as an event. Above a day it stops moving at all, which is the problem
 * it exists to solve. An hour gives three to five distinct lines per session.
 */
export const AMBIENT_BUCKET_MS = 60 * 60 * 1000;

/** Which ambient slot `now` falls in. UTC epoch division, so no timezone reasoning. */
export function ambientCycle(now: Date, bucketMs = AMBIENT_BUCKET_MS): number {
  const ms = now.getTime();
  if (!Number.isFinite(ms) || bucketMs <= 0) return 0;
  return Math.floor(ms / bucketMs);
}

/**
 * Picks a line by position rather than by hash.
 *
 * `speak` hashes its seed, which is right for events — a seed there is a key,
 * not an ordinal. For a line that advances on a clock, hashing would land on
 * the same line in consecutive buckets roughly one time in n, and a "rotating"
 * line showing the same words two hours running reads as broken. Counter-mod
 * guarantees every step moves, and that the whole bank is seen before anything
 * repeats.
 */
export function speakCycle(tone: ToneName, key: SpeakKey, cycle: number): string {
  const bank = TONE_BANKS[tone] ?? TONE_BANKS.deadpan;
  const lines = bank[key];
  if (!lines || lines.length === 0) return '';
  const n = lines.length;
  const safe = Number.isFinite(cycle) ? Math.trunc(cycle) : 0;
  return lines[((safe % n) + n) % n] ?? '';
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

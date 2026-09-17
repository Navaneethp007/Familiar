import { describe, expect, it } from 'vitest';

import {
  AMBIENT_BUCKET_MS,
  ambientCycle,
  SPEAK_COOLDOWN_MS,
  SPEAK_KEYS,
  shouldSpeak,
  speak,
  speakCycle,
  TONE_BANKS,
  TONES,
} from '../src/core/tone.js';

describe('tone banks', () => {
  it('exists for every tone', () => {
    for (const tone of TONES) expect(TONE_BANKS[tone]).toBeDefined();
  });

  it('has at least two lines for every speakable moment', () => {
    for (const tone of TONES) {
      for (const key of SPEAK_KEYS) {
        const lines = TONE_BANKS[tone][key];
        expect(lines, `${tone}.${key}`).toBeDefined();
        expect(lines.length, `${tone}.${key}`).toBeGreaterThanOrEqual(2);
        for (const line of lines) expect(line.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('keeps lines short enough for a statusline', () => {
    for (const tone of TONES) {
      for (const key of SPEAK_KEYS) {
        for (const line of TONE_BANKS[tone][key]) {
          expect(line.length, `${tone}.${key}: "${line}"`).toBeLessThanOrEqual(60);
        }
      }
    }
  });

  it('never addresses the person rather than the work', () => {
    // The discipline from the design: comment on the code, never the coder.
    const secondPersonJudgement = /\byou('re| are)\s+(bad|lazy|slow|sloppy|stupid|useless|failing)\b/i;
    for (const tone of TONES) {
      for (const key of SPEAK_KEYS) {
        for (const line of TONE_BANKS[tone][key]) {
          expect(secondPersonJudgement.test(line), `${tone}.${key}: "${line}"`).toBe(false);
        }
      }
    }
  });
});

describe('speak', () => {
  it('is deterministic for the same tone, key and seed', () => {
    const first = speak('gremlin', 'pr_merged', 'abc');
    for (let i = 0; i < 25; i++) expect(speak('gremlin', 'pr_merged', 'abc')).toBe(first);
  });

  it('changes voice with the tone', () => {
    const lines = new Set(TONES.map((tone) => speak(tone, 'pr_merged', 'seed')));
    expect(lines.size).toBeGreaterThan(1);
  });

  it('spreads different seeds across the bank', () => {
    const lines = new Set(
      Array.from({ length: 40 }, (_, i) => speak('deadpan', 'commit', `seed-${i}`)),
    );
    expect(lines.size).toBeGreaterThan(1);
  });

  it('always returns a real line from the requested bank', () => {
    for (const tone of TONES) {
      for (const key of SPEAK_KEYS) {
        const line = speak(tone, key, 'x');
        expect(TONE_BANKS[tone][key]).toContain(line);
      }
    }
  });
});

describe('shouldSpeak', () => {
  const now = new Date('2026-07-30T12:00:00Z');

  it('speaks when it has never spoken', () => {
    expect(shouldSpeak(null, now)).toBe(true);
    expect(shouldSpeak(undefined, now)).toBe(true);
  });

  it('stays quiet inside the cooldown', () => {
    const justNow = new Date(now.getTime() - 1_000).toISOString();
    expect(shouldSpeak(justNow, now)).toBe(false);
  });

  it('speaks again once the cooldown has passed', () => {
    const older = new Date(now.getTime() - SPEAK_COOLDOWN_MS - 1).toISOString();
    expect(shouldSpeak(older, now)).toBe(true);
  });

  it('speaks when the stored timestamp is unreadable', () => {
    expect(shouldSpeak('not-a-date', now)).toBe(true);
  });
});

describe('ambientCycle', () => {
  const noon = new Date('2026-07-30T12:00:00Z');

  it('holds steady inside the bucket', () => {
    const fivePast = new Date('2026-07-30T12:05:00Z');
    const fiftyPast = new Date('2026-07-30T12:50:00Z');
    expect(ambientCycle(fivePast)).toBe(ambientCycle(noon));
    expect(ambientCycle(fiftyPast)).toBe(ambientCycle(noon));
  });

  it('advances by exactly one when the hour turns', () => {
    const later = new Date(noon.getTime() + AMBIENT_BUCKET_MS);
    expect(ambientCycle(later)).toBe(ambientCycle(noon) + 1);
  });

  it('survives an unreadable date instead of returning NaN', () => {
    expect(ambientCycle(new Date('nonsense'))).toBe(0);
  });
});

describe('speakCycle', () => {
  it('walks the whole bank before repeating', () => {
    for (const tone of TONES) {
      const bank = TONE_BANKS[tone].at_peace;
      const seen = bank.map((_, i) => speakCycle(tone, 'at_peace', i));
      expect(new Set(seen).size, tone).toBe(bank.length);
    }
  });

  // The reason this exists rather than reusing `speak`: a hash would land on
  // the same line in consecutive buckets about one time in n, and a rotating
  // line that repeats reads as a stuck statusline.
  it('never says the same thing twice in a row', () => {
    for (const tone of TONES) {
      const bank = TONE_BANKS[tone].at_peace;
      for (let i = 0; i < bank.length * 3; i++) {
        expect(speakCycle(tone, 'at_peace', i), `${tone}@${i}`).not.toBe(
          speakCycle(tone, 'at_peace', i + 1),
        );
      }
    }
  });

  it('wraps cleanly around negative and enormous cycles', () => {
    const bank = TONE_BANKS.deadpan.at_peace;
    for (const cycle of [-1, -9_999, 0, Number.MAX_SAFE_INTEGER]) {
      expect(bank, String(cycle)).toContain(speakCycle('deadpan', 'at_peace', cycle));
    }
    expect(bank).toContain(speakCycle('deadpan', 'at_peace', Number.NaN));
  });

  it('is deterministic for a given cycle', () => {
    const runs = Array.from({ length: 12 }, () => speakCycle('gremlin', 'at_peace', 7));
    expect(new Set(runs).size).toBe(1);
  });

  it('falls back to deadpan for an unknown tone', () => {
    const line = speakCycle('nonsense' as never, 'at_peace', 3);
    expect(TONE_BANKS.deadpan.at_peace).toContain(line);
  });
});

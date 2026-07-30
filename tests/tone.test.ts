import { describe, expect, it } from 'vitest';

import {
  SPEAK_COOLDOWN_MS,
  SPEAK_KEYS,
  shouldSpeak,
  speak,
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

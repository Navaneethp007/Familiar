import { describe, expect, it } from 'vitest';

import { profileRhythm, scoreSpecies, selectSpecies, SPECIES } from '../src/core/species.js';

const NOW = new Date('2026-07-30T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function daysAgo(n: number, count = 1): Date[] {
  return Array.from({ length: count }, (_, i) => new Date(NOW.getTime() - n * DAY + i * 60_000));
}

describe('profileRhythm', () => {
  it('ignores commits outside the window', () => {
    const profile = profileRhythm([...daysAgo(5), ...daysAgo(400)], 60, NOW);
    expect(profile.totalCommits).toBe(1);
  });

  it('reports no activity for an empty history', () => {
    const profile = profileRhythm([], 60, NOW);
    expect(profile.totalCommits).toBe(0);
    expect(profile.activeDays).toBe(0);
    expect(profile.commitsPerActiveDay).toBe(0);
    expect(Number.isFinite(profile.activeRatio)).toBe(true);
  });

  it('counts distinct days, not commits', () => {
    const profile = profileRhythm([...daysAgo(3, 9), ...daysAgo(4, 2)], 60, NOW);
    expect(profile.totalCommits).toBe(11);
    expect(profile.activeDays).toBe(2);
  });
});

describe('selectSpecies', () => {
  it('gives the neutral starter when there is no history to read', () => {
    expect(selectSpecies(profileRhythm([], 60, NOW))).toBe('sprout');
  });

  it('reads a steady daily rhythm as Sprout', () => {
    const dates: Date[] = [];
    for (let d = 1; d <= 55; d++) dates.push(...daysAgo(d, 2));
    expect(selectSpecies(profileRhythm(dates, 60, NOW))).toBe('sprout');
  });

  it('reads rare enormous days as Ember', () => {
    const dates = [...daysAgo(2, 30), ...daysAgo(14, 26), ...daysAgo(30, 34)];
    expect(selectSpecies(profileRhythm(dates, 60, NOW))).toBe('ember');
  });

  it('reads thin scattered activity as Wisp', () => {
    const dates = [...daysAgo(4, 1), ...daysAgo(41, 1)];
    expect(selectSpecies(profileRhythm(dates, 60, NOW))).toBe('wisp');
  });

  it('always returns a known species and finite scores', () => {
    const samples = [
      profileRhythm([], 60, NOW),
      profileRhythm(daysAgo(1, 1), 60, NOW),
      profileRhythm(daysAgo(1, 900), 60, NOW),
    ];
    for (const profile of samples) {
      expect(SPECIES).toContain(selectSpecies(profile));
      for (const score of Object.values(scoreSpecies(profile))) {
        expect(Number.isFinite(score)).toBe(true);
      }
    }
  });
});

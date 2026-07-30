/**
 * Palettes.
 *
 * Every grid is drawn with the same abstract character set; a palette maps
 * those characters to colours. That is what lets three species share silhouette
 * work and still look like three different creatures, and it is why an
 * evolution can change the whole feel of a sprite for free.
 */

import type { Branch } from '../habits.js';
import type { Species } from '../species.js';
import type { Mood } from '../xp.js';

/**
 * ` ` / `.` transparent
 * `0` outline      `1` body        `2` body light   `3` body shadow / mouth
 * `4` accent       `5` accent light `6` eye          `7` glow
 */
export type PaletteKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7';

export type Palette = Record<PaletteKey, string>;

export const SPECIES_PALETTES: Record<Species, Palette> = {
  sprout: {
    '0': '#1d3320',
    '1': '#5aa860',
    '2': '#87d387',
    '3': '#33724a',
    '4': '#c9e86b',
    '5': '#eaffa8',
    '6': '#12210f',
    '7': '#f4ffd0',
  },
  ember: {
    '0': '#3a1408',
    '1': '#e2622a',
    '2': '#ffa94d',
    '3': '#a83c17',
    '4': '#ffd24a',
    '5': '#fff0b0',
    '6': '#2a0d05',
    '7': '#fff3c4',
  },
  wisp: {
    '0': '#1b1f3a',
    '1': '#7b86c9',
    '2': '#b6bef0',
    '3': '#4a5290',
    '4': '#9ef0ff',
    '5': '#e3fbff',
    '6': '#101228',
    '7': '#cfe8ff',
  },
};

/** Each branch recolours the accent, so the motif reads as *its* motif. */
export const BRANCH_ACCENTS: Record<Branch, { accent: string; accentLight: string; glow: string }> =
  {
    night_owl: { accent: '#8f7bd6', accentLight: '#d9cbff', glow: '#f2ecff' },
    test_guardian: { accent: '#48c9a0', accentLight: '#b6f5e2', glow: '#e6fff8' },
    speed_demon: { accent: '#ffd233', accentLight: '#fff2a8', glow: '#fffbe0' },
    firefighter: { accent: '#e04b3a', accentLight: '#ffb3a3', glow: '#ffe8e2' },
    refactorer: { accent: '#7f8fa6', accentLight: '#cfd8e6', glow: '#eef3f9' },
    one_shot: { accent: '#f26fa1', accentLight: '#ffc4da', glow: '#ffeaf2' },
    conjurer: { accent: '#5ac8e0', accentLight: '#c2f0fa', glow: '#eafbff' },
  };

/** Mood is a light tint over the whole sprite, not a redraw. */
export const MOOD_TINTS: Record<Mood, { overlay: string | null; alpha: number }> = {
  happy: { overlay: '#fff3b0', alpha: 0.14 },
  neutral: { overlay: null, alpha: 0 },
  sad: { overlay: '#5566aa', alpha: 0.22 },
  alarmed: { overlay: '#ff5a4d', alpha: 0.2 },
};

export function paletteFor(species: Species, branch: Branch | null): Palette {
  const base = { ...SPECIES_PALETTES[species] };
  if (branch) {
    const accent = BRANCH_ACCENTS[branch];
    base['4'] = accent.accent;
    base['5'] = accent.accentLight;
    base['7'] = accent.glow;
  }
  return base;
}

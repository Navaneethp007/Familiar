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
 * `0` deep shadow  `1` dim stroke  `2` primary stroke  `3` interior detail
 * `4` accent       `5` accent light `6` eye            `7` glow
 *
 * The art is monoline — a 1px outline with nothing inside it — so the roles are
 * not what they were when creatures were filled shapes. `2` is the stroke you
 * actually see and has to be the *bright* tone: a dark outline needs a lit fill
 * behind it to read, and there isn't one any more.
 *
 * `1` is deliberately one step down from `2`, because `blink()` is a global
 * `6` → `1` substitution. An eye that dims to a secondary stroke reads as a
 * closed lid; an eye that dims to the background would just vanish, and the
 * blink test requires the drawn-pixel count to stay identical.
 *
 * **Which of these the art actually draws**, as of the monoline redraw: `2`,
 * `3`, `4` and `6`, plus `1` at render time via blink. `0`, `5` and `7` are
 * reserved and currently unreferenced — so a branch's colour reaches the screen
 * entirely through `4`, and changing `5` or `7` will appear to do nothing until
 * some future art uses them. They are kept because BRANCH_ACCENTS supplies all
 * three and the widget looks each character up blindly; an index with no colour
 * is skipped in silence rather than erroring.
 */
export type PaletteKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7';

export type Palette = Record<PaletteKey, string>;

export const SPECIES_PALETTES: Record<Species, Palette> = {
  sprout: {
    '0': '#1d3320',
    '1': '#3f7a46',
    '2': '#7fd68a',
    '3': '#57a862',
    '4': '#c9e86b',
    '5': '#eaffa8',
    '6': '#f4ffd0',
    '7': '#f4ffd0',
  },
  ember: {
    '0': '#3a1408',
    '1': '#9c4f2a',
    '2': '#f2914e',
    '3': '#c96a30',
    '4': '#ffd24a',
    '5': '#fff0b0',
    '6': '#fff3c4',
    '7': '#fff3c4',
  },
  wisp: {
    '0': '#1b1f3a',
    '1': '#5a63a0',
    '2': '#a8b2ea',
    '3': '#7b86c9',
    '4': '#9ef0ff',
    '5': '#e3fbff',
    '6': '#e8f2ff',
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

/**
 * Palettes the user can pick from.
 *
 * Species and branch are both *earned* — one from your git rhythm, one from
 * habits observed over fifteen levels. Neither is chosen. Colour is the one
 * thing about your familiar that is purely yours, which is why it is the only
 * appearance setting and why it is worth exactly zero XP.
 */
export const COLOURS = ['moss', 'ember', 'wisp', 'ice', 'rose', 'mono'] as const;
export type ColourName = (typeof COLOURS)[number];

export const COLOUR_LABELS: Record<ColourName, string> = {
  moss: 'Moss',
  ember: 'Ember',
  wisp: 'Wisp',
  ice: 'Ice',
  rose: 'Rose',
  mono: 'Mono',
};

/**
 * The first three deliberately match the species palettes, so someone who picks
 * their own species' colour sees no change at all.
 */
export const COLOUR_PALETTES: Record<ColourName, Palette> = {
  moss: { ...SPECIES_PALETTES.sprout },
  ember: { ...SPECIES_PALETTES.ember },
  wisp: { ...SPECIES_PALETTES.wisp },
  ice: {
    '0': '#0f2a33',
    '1': '#2f6f7d',
    '2': '#6fd4e4',
    '3': '#4aa2b4',
    '4': '#a8f0ff',
    '5': '#e6fbff',
    '6': '#f0feff',
    '7': '#f0feff',
  },
  rose: {
    '0': '#3a1220',
    '1': '#8c3a56',
    '2': '#ef7fa2',
    '3': '#c85b7e',
    '4': '#ffb3c9',
    '5': '#ffe4ec',
    '6': '#fff0f5',
    '7': '#fff0f5',
  },
  mono: {
    '0': '#2b2b2b',
    '1': '#707070',
    '2': '#d4d4d4',
    '3': '#9a9a9a',
    '4': '#f0f0f0',
    '5': '#ffffff',
    '6': '#ffffff',
    '7': '#ffffff',
  },
};

/**
 * The palette before any branch accent is applied.
 *
 * `null` means "use the species' own", which is what keeps every familiar that
 * existed before colour was a setting looking exactly as it did.
 */
export function basePalette(species: Species, colour: ColourName | null | undefined): Palette {
  if (colour && (COLOURS as readonly string[]).includes(colour)) {
    return { ...COLOUR_PALETTES[colour] };
  }
  // An unrecognised name falls back rather than throwing. A palette of
  // `undefined` would render a completely invisible creature — the web widget
  // skips any character it has no colour for, silently.
  return { ...SPECIES_PALETTES[species] };
}

export function paletteFor(
  species: Species,
  branch: Branch | null,
  colour?: ColourName | null,
): Palette {
  const base = basePalette(species, colour);
  if (branch) {
    const accent = BRANCH_ACCENTS[branch];
    base['4'] = accent.accent;
    base['5'] = accent.accentLight;
    base['7'] = accent.glow;
  }
  return base;
}

/**
 * Drawing the familiar in a terminal.
 *
 * The same 16×16 grids the web widget uses, folded two rows at a time into
 * half-block characters so a 16×16 sprite occupies 16 columns × 8 rows — which,
 * given a terminal cell is about twice as tall as it is wide, comes out square.
 *
 * Everything here is pure. Capability detection takes its inputs as arguments
 * rather than reading `process`, so every colour tier is testable without
 * touching a global, and the renderer can be handed a fake terminal.
 */

import { BRANCH_LABELS, type Branch } from '../core/habits.js';
import { formIdentity } from '../core/forms.js';
import { SPECIES_BLURBS, SPECIES_LABELS, type Species } from '../core/species.js';
import { SPRITE_SIZE, type Grid } from '../core/sprites/grids.js';
import { MOOD_TINTS, type Palette, type PaletteKey } from '../core/sprites/palettes.js';
import type { Mood, Stage } from '../core/xp.js';

// --- capabilities ----------------------------------------------------------

export type ColorTier = 'truecolor' | 'ansi256' | 'mono';

export interface TermCaps {
  tier: ColorTier;
  /** Terminal height when known. Gates the animation, which moves the cursor. */
  rows: number | null;
  /**
   * Terminal width when known.
   *
   * Matters as much as height: a frame wider than the terminal soft-wraps, and
   * a wrapped block occupies more physical rows than it has lines. Cursor-up by
   * the line count then lands in the middle of the previous frame instead of
   * above it, so the animation redraws through itself.
   */
  columns: number | null;
}

/**
 * Resolves what the terminal can do.
 *
 * Order matters and each rule earns its place:
 *
 * - `NO_COLOR` is checked by **presence**, not truthiness. `NO_COLOR=` with an
 *   empty value is a valid opt-out per the convention, and reading it as falsy
 *   is the single most common way to get this wrong.
 * - `FORCE_COLOR` exists so the coloured paths can be exercised at all. A test
 *   runner's stdout is never a TTY, so without it the colour tiers would be
 *   unreachable outside a real terminal. Note this diverges from the usual
 *   1/2/3 = 16/256/truecolor convention and treats any non-'0' value as
 *   truecolor. Deliberate: there is no 16-colour tier here, and the flag's job
 *   is to reach the richest path, so mapping the commonest value ('1') to the
 *   poorest one would defeat the only reason it exists.
 * - Windows is assumed truecolor. Windows Terminal and modern conhost both do
 *   24-bit but set neither TERM nor COLORTERM, so without this every Windows
 *   user silently falls to the 256 tier.
 */
export function detectCaps(
  env: Record<string, string | undefined>,
  isTTY: boolean,
  platform: NodeJS.Platform,
  rows?: number,
  columns?: number,
): TermCaps {
  const height = typeof rows === 'number' && rows > 0 ? rows : null;
  const width = typeof columns === 'number' && columns > 0 ? columns : null;
  const tier = ((): ColorTier => {
    if ('NO_COLOR' in env) return 'mono';
    const force = env['FORCE_COLOR'];
    if (force !== undefined && force !== '0') return 'truecolor';
    if (!isTTY) return 'mono';
    if (env['TERM'] === 'dumb') return 'mono';
    const colorterm = env['COLORTERM'];
    if (colorterm === 'truecolor' || colorterm === '24bit') return 'truecolor';
    if ((env['TERM'] ?? '').includes('256color')) return 'ansi256';
    if (platform === 'win32') return 'truecolor';
    return 'ansi256';
  })();

  return { tier, rows: height, columns: width };
}

/**
 * The visible width of a rendered frame, ignoring colour escapes.
 *
 * Measured from the frame rather than computed from the sprite size, for the
 * same reason its height is: the two renderers produce different geometry, and
 * anything deriving one from a constant will eventually disagree with what was
 * actually drawn.
 */
export function frameWidth(frame: string): number {
  let widest = 0;
  for (const line of frame.split('\n')) {
    widest = Math.max(widest, line.replace(/\x1b\[[0-9;]*m/g, '').length);
  }
  return widest;
}

// --- colour ----------------------------------------------------------------

export type Rgb = readonly [number, number, number];

export function hexToRgb(hex: string): Rgb | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = Number.parseInt(match[1] as string, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function toHex(rgb: Rgb): string {
  return '#' + rgb.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');
}

/** The six levels the xterm 6×6×6 cube quantises to. */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;

/**
 * Every xterm-256 colour worth matching against, as [index, r, g, b].
 *
 * Indices 0–15 are deliberately excluded: they are whatever the user's theme
 * says they are, so matching against them produces a creature whose colours
 * change when the terminal theme does — which defeats having a palette at all.
 */
const PALETTE_256: Array<readonly [number, number, number, number]> = (() => {
  const entries: Array<readonly [number, number, number, number]> = [];
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        entries.push([
          16 + 36 * r + 6 * g + b,
          CUBE_LEVELS[r] as number,
          CUBE_LEVELS[g] as number,
          CUBE_LEVELS[b] as number,
        ]);
      }
    }
  }
  for (let i = 0; i < 24; i++) {
    const level = 8 + 10 * i;
    entries.push([232 + i, level, level, level]);
  }
  return entries;
})();

/**
 * Nearest xterm-256 index by squared RGB distance.
 *
 * Brute force over 240 entries. The analytic shortcut has real edge cases
 * around the boundary between the cube and the grey ramp, and this runs eight
 * times per render — the arithmetic is free and the correctness is not.
 */
export function nearest256(rgb: Rgb): number {
  let best = 16;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [index, r, g, b] of PALETTE_256) {
    const dr = rgb[0] - r;
    const dg = rgb[1] - g;
    const db = rgb[2] - b;
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

/** Mixes `hex` toward `overlay`. alpha 0 keeps the base, 1 takes the overlay. */
export function blend(hex: string, overlay: string, alpha: number): string {
  const base = hexToRgb(hex);
  const tint = hexToRgb(overlay);
  if (!base || !tint) return hex;
  const a = Math.min(1, Math.max(0, alpha));
  return toHex([
    base[0] * (1 - a) + tint[0] * a,
    base[1] * (1 - a) + tint[1] * a,
    base[2] * (1 - a) + tint[2] * a,
  ]);
}

const PALETTE_KEYS: readonly PaletteKey[] = ['0', '1', '2', '3', '4', '5', '6', '7'];

/**
 * Applies the mood tint across a whole palette, once, before any pixel work.
 *
 * At the alphas the moods use this is a subtle shift, and on the 256 tier it
 * will often quantise back to the same index and become a visual no-op. That is
 * a fine failure mode: it degrades to "no tint", never to "wrong colour".
 */
export function tintPalette(palette: Palette, mood: Mood): Palette {
  const tint = MOOD_TINTS[mood];
  if (!tint || tint.overlay === null || tint.alpha <= 0) return palette;

  const out = {} as Record<PaletteKey, string>;
  for (const key of PALETTE_KEYS) out[key] = blend(palette[key], tint.overlay, tint.alpha);
  return out;
}

// --- the sprite ------------------------------------------------------------

const RESET = '\x1b[0m';
const DEFAULT_BG = '\x1b[49m';

/** Transparent. Grids use '.' but tolerate a space, so both must count. */
function isTransparent(ch: string): boolean {
  return ch === '.' || ch === ' ' || ch === '';
}

function fg(hex: string, tier: ColorTier): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return '';
  if (tier === 'truecolor') return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
  return `\x1b[38;5;${nearest256(rgb)}m`;
}

function bg(hex: string, tier: ColorTier): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return '';
  if (tier === 'truecolor') return `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
  return `\x1b[48;5;${nearest256(rgb)}m`;
}

export interface SpriteRenderInput {
  grid: Grid;
  palette: Palette;
  caps: TermCaps;
  /** Left margin. Two spaces matches the status card's indentation. */
  indent?: number;
}

/** How many text rows `renderSprite` produces. Half-blocks fold two grid rows into one. */
export const SPRITE_TEXT_ROWS = SPRITE_SIZE / 2;

/**
 * Renders the grid as half-blocks. Returns 8 lines, newline-joined, no trailing
 * newline.
 *
 * The four opacity cases each need their own glyph. `▀` paints its *top* half in
 * the foreground and its bottom half in the background, and there is no such
 * thing as a transparent foreground — the "default foreground" escape is a
 * colour, usually near-white. So a cell whose top pixel is transparent and whose
 * bottom is not cannot be drawn with `▀` at all; it needs `▄`, which inverts the
 * halves. Getting this wrong paints a solid block where the sprite should be
 * showing the terminal through.
 */
export function renderSprite(input: SpriteRenderInput): string {
  const { grid, palette, caps } = input;
  const margin = ' '.repeat(input.indent ?? 2);
  const mono = caps.tier === 'mono';
  const lines: string[] = [];

  for (let y = 0; y < SPRITE_SIZE; y += 2) {
    const topRow = grid[y] ?? '';
    const bottomRow = grid[y + 1] ?? '';
    let line = margin;

    for (let x = 0; x < SPRITE_SIZE; x++) {
      const top = topRow[x] ?? '.';
      const bottom = bottomRow[x] ?? '.';
      const topOpaque = !isTransparent(top);
      const bottomOpaque = !isTransparent(bottom);

      if (!topOpaque && !bottomOpaque) {
        line += ' ';
      } else if (mono) {
        line += topOpaque && bottomOpaque ? '█' : topOpaque ? '▀' : '▄';
      } else if (topOpaque && bottomOpaque) {
        line += fg(palette[top as PaletteKey], caps.tier) + bg(palette[bottom as PaletteKey], caps.tier) + '▀';
      } else if (topOpaque) {
        line += fg(palette[top as PaletteKey], caps.tier) + DEFAULT_BG + '▀';
      } else {
        line += fg(palette[bottom as PaletteKey], caps.tier) + DEFAULT_BG + '▄';
      }
    }

    // Close every row. A row that ends with a background still set can bleed
    // when the terminal scrolls or reflows.
    lines.push(mono ? line : line + RESET);
  }

  return lines.join('\n');
}

/** How many text rows `renderSpriteFull` produces: one per pixel row. */
export const SPRITE_FULL_ROWS = SPRITE_SIZE;

/**
 * Renders the grid at full resolution: one text row per pixel row.
 *
 * The half-block renderer above packs two pixel rows into one cell, which is
 * compact but throws away half the vertical detail — and on monoline art, where
 * every stroke is one pixel, that is exactly the detail the drawing is made of.
 * Here each pixel is two spaces coloured by background instead, so nothing is
 * merged and the result is pixel-identical to the widget. Two cells wide comes
 * out roughly square, because a terminal cell is about twice as tall as it is
 * wide.
 *
 * The cost is size: 32 columns by 16 rows rather than 16 by 8.
 */
export function renderSpriteFull(input: SpriteRenderInput): string {
  const { grid, palette, caps } = input;
  const margin = ' '.repeat(input.indent ?? 2);
  const mono = caps.tier === 'mono';
  const lines: string[] = [];

  for (let y = 0; y < SPRITE_SIZE; y++) {
    const row = grid[y] ?? '';
    let line = margin;

    for (let x = 0; x < SPRITE_SIZE; x++) {
      const ch = row[x] ?? '.';
      if (isTransparent(ch)) {
        // Two spaces with the terminal's own background showing through.
        line += mono ? '  ' : `${DEFAULT_BG}  `;
      } else if (mono) {
        // No colour to paint with, so the shape is carried by the glyph.
        line += '██';
      } else {
        line += `${bg(palette[ch as PaletteKey], caps.tier)}  `;
      }
    }

    // Trailing spaces are kept rather than trimmed, so both renderers produce
    // the same shape for the same grid: every row is exactly as wide as the
    // sprite. The half-block renderer above does the same, and a difference
    // here would only ever surface as a confusing test failure.
    lines.push(mono ? line : line + RESET);
  }

  return lines.join('\n');
}

// --- the identity block ----------------------------------------------------

export interface IdentityInput {
  species: Species;
  stage: Stage;
  branch: Branch | null;
  level: number;
  quip?: string | null;
}

/**
 * The text beside the sprite. Deliberately mirrors the status card's header so
 * the two surfaces read as one product rather than two takes on the same data.
 */
export function renderIdentity(input: IdentityInput): string {
  const form = formIdentity(input.species, input.stage, input.branch);
  const lines: string[] = [];

  lines.push(`  ${form.emoji}  ${form.name}  ·  Lv.${input.level}`);
  lines.push(`      ${SPECIES_LABELS[input.species]} — ${SPECIES_BLURBS[input.species]}`);
  if (input.branch) lines.push(`      evolved: ${BRANCH_LABELS[input.branch]}`);
  if (input.quip) {
    lines.push('');
    lines.push(`      "${input.quip}"`);
  }

  return lines.join('\n');
}

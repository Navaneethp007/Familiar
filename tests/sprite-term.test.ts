import { describe, expect, it } from 'vitest';

import { BRANCHES } from '../src/core/habits.js';
import { SPECIES } from '../src/core/species.js';
import { gridFor, SPRITE_SIZE, type Grid } from '../src/core/sprites/grids.js';
import { paletteFor } from '../src/core/sprites/palettes.js';
import {
  blend,
  detectCaps,
  frameWidth,
  hexToRgb,
  nearest256,
  renderSprite,
  renderSpriteFull,
  SPRITE_FULL_ROWS,
  SPRITE_TEXT_ROWS,
  tintPalette,
  type ColorTier,
  type TermCaps,
} from '../src/ui/sprite-term.js';
import type { Mood, Stage } from '../src/core/xp.js';

const STAGES: Stage[] = ['egg', 'hatchling', 'final'];
const SPROUT = paletteFor('sprout', null);

const caps = (tier: ColorTier): TermCaps => ({ tier, rows: 40, columns: 120 });

/** A grid whose first two rows are given and whose rest is transparent. */
function gridOf(top: string, bottom: string): Grid {
  const blank = '.'.repeat(SPRITE_SIZE);
  return [top, bottom, ...Array.from({ length: SPRITE_SIZE - 2 }, () => blank)];
}

const ESCAPES = /\x1b\[[0-9;]*m/g;
const stripped = (text: string): string => text.replace(ESCAPES, '');

describe('renderSprite geometry', () => {
  it('folds every form in the tree into exactly eight rows, at every tier', () => {
    for (const species of SPECIES) {
      for (const stage of STAGES) {
        for (const branch of [...BRANCHES, null]) {
          const grid = gridFor(species, stage, branch);
          const palette = paletteFor(species, branch);
          for (const tier of ['truecolor', 'ansi256', 'mono'] as const) {
            const lines = renderSprite({ grid, palette, caps: caps(tier) }).split('\n');
            expect(lines.length, `${species}/${stage}/${branch}/${tier}`).toBe(SPRITE_TEXT_ROWS);
          }
        }
      }
    }
  });

  it('renders sixteen visible cells per row whatever the escapes', () => {
    const grid = gridFor('ember', 'final', 'firefighter');
    const palette = paletteFor('ember', 'firefighter');
    for (const tier of ['truecolor', 'ansi256', 'mono'] as const) {
      for (const line of renderSprite({ grid, palette, caps: caps(tier), indent: 2 }).split('\n')) {
        expect(stripped(line), `${tier}: "${line}"`).toHaveLength(2 + SPRITE_SIZE);
      }
    }
  });

  it('is deterministic', () => {
    const input = { grid: gridFor('wisp', 'final', 'conjurer'), palette: SPROUT, caps: caps('truecolor') };
    const first = renderSprite(input);
    for (let i = 0; i < 20; i++) expect(renderSprite(input)).toBe(first);
  });
});

// `▀` paints its top half in the foreground and there is no transparent
// foreground, so a transparent top pixel is inexpressible with it. Each of
// these four cases needs its own glyph, and the third is the one that a
// naive always-`▀` implementation gets wrong.
describe('the four opacity cases', () => {
  const render = (top: string, bottom: string, tier: ColorTier = 'truecolor'): string =>
    renderSprite({ grid: gridOf(top, bottom), palette: SPROUT, caps: caps(tier) }).split('\n')[0] ?? '';

  it('paints an upper half-block when both pixels are opaque', () => {
    const line = render('1'.repeat(SPRITE_SIZE), '2'.repeat(SPRITE_SIZE));
    expect(line).toContain('▀');
    expect(line).toMatch(/\x1b\[38;2;/);
    expect(line).toMatch(/\x1b\[48;2;/);
  });

  it('resets the background when only the top pixel is opaque', () => {
    const line = render('1'.repeat(SPRITE_SIZE), '.'.repeat(SPRITE_SIZE));
    expect(line).toContain('▀');
    expect(line).toContain('\x1b[49m');
    expect(line).not.toMatch(/\x1b\[48;2;/);
  });

  it('flips to a lower half-block when only the bottom pixel is opaque', () => {
    const line = render('.'.repeat(SPRITE_SIZE), '1'.repeat(SPRITE_SIZE));
    expect(line).toContain('▄');
    expect(line).not.toContain('▀');
    expect(line).toContain('\x1b[49m');
    expect(line).not.toMatch(/\x1b\[48;2;/);
  });

  it('emits a bare space when neither pixel is opaque', () => {
    const line = render('.'.repeat(SPRITE_SIZE), '.'.repeat(SPRITE_SIZE));
    expect(stripped(line).trim()).toBe('');
    expect(line).not.toMatch(/\x1b\[38;2;/);
    expect(line).not.toMatch(/\x1b\[48;2;/);
  });

  it('treats a space in the grid as transparent, like a dot', () => {
    const withDots = render('.'.repeat(SPRITE_SIZE), '1'.repeat(SPRITE_SIZE));
    const withSpaces = render(' '.repeat(SPRITE_SIZE), '1'.repeat(SPRITE_SIZE));
    expect(withSpaces).toBe(withDots);
  });
});

describe('colour tiers', () => {
  const grid = gridFor('sprout', 'hatchling', null);

  it('emits 24-bit sequences on truecolor and never indexed ones', () => {
    const out = renderSprite({ grid, palette: SPROUT, caps: caps('truecolor') });
    expect(out).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
    expect(out).not.toMatch(/\x1b\[38;5;/);
  });

  it('emits indexed sequences on ansi256 and never 24-bit ones', () => {
    const out = renderSprite({ grid, palette: SPROUT, caps: caps('ansi256') });
    expect(out).toMatch(/\x1b\[38;5;\d{1,3}m/);
    expect(out).not.toMatch(/\x1b\[38;2;/);
  });

  // Dropping the sprite entirely would punish someone for an accessibility
  // preference. The silhouette survives; only the colour goes.
  it('still draws a creature on the mono tier, with no escapes at all', () => {
    const out = renderSprite({ grid, palette: SPROUT, caps: caps('mono') });
    expect(out).not.toContain('\x1b');
    for (const line of out.split('\n')) expect(line).toMatch(/^[ █▀▄]+$/);
    expect(out).toMatch(/[█▀▄]/);
  });

  it('closes every coloured row so nothing bleeds on scroll', () => {
    for (const tier of ['truecolor', 'ansi256'] as const) {
      for (const line of renderSprite({ grid, palette: SPROUT, caps: caps(tier) }).split('\n')) {
        expect(line.endsWith('\x1b[0m'), `${tier}: "${line}"`).toBe(true);
      }
    }
  });
});

describe('renderSpriteFull', () => {
  const grid = gridFor('sprout', 'final', 'night_owl');
  const palette = paletteFor('sprout', 'night_owl');

  // The whole point: one text row per pixel row, so nothing is averaged away.
  it('gives every pixel row its own line', () => {
    for (const tier of ['truecolor', 'ansi256', 'mono'] as const) {
      const lines = renderSpriteFull({ grid, palette, caps: caps(tier) }).split('\n');
      expect(lines.length, tier).toBe(SPRITE_FULL_ROWS);
      expect(lines.length).toBe(SPRITE_SIZE);
    }
  });

  it('is twice as wide as it is tall in cells, so pixels come out square', () => {
    const line = renderSpriteFull({ grid, palette, caps: caps('truecolor'), indent: 0 }).split('\n')[0];
    expect(stripped(line ?? '')).toHaveLength(SPRITE_SIZE * 2);
  });

  it('paints with backgrounds rather than glyphs', () => {
    const out = renderSpriteFull({ grid, palette, caps: caps('truecolor') });
    expect(out).toMatch(/\x1b\[48;2;\d+;\d+;\d+m/);
    for (const glyph of ['▀', '▄', '█']) expect(out).not.toContain(glyph);
  });

  it('still draws a creature with no colour at all', () => {
    const out = renderSpriteFull({ grid, palette, caps: caps('mono') });
    expect(out).not.toContain('\x1b');
    expect(out).toContain('██');
  });

  it('carries strictly more detail than the folded version', () => {
    const full = renderSpriteFull({ grid, palette, caps: caps('mono') }).split('\n');
    const folded = renderSprite({ grid, palette, caps: caps('mono') }).split('\n');
    expect(full.length).toBeGreaterThan(folded.length);
    // Distinct row patterns survive full-res that the fold merges together.
    expect(new Set(full).size).toBeGreaterThan(new Set(folded).size);
  });

  it('is deterministic', () => {
    const input = { grid, palette, caps: caps('truecolor') };
    const first = renderSpriteFull(input);
    for (let i = 0; i < 10; i++) expect(renderSpriteFull(input)).toBe(first);
  });
});

describe('detectCaps', () => {
  it('honours NO_COLOR by presence, not by truthiness', () => {
    expect(detectCaps({ NO_COLOR: '' }, true, 'linux').tier).toBe('mono');
    expect(detectCaps({ NO_COLOR: '0' }, true, 'linux').tier).toBe('mono');
  });

  it('lets NO_COLOR outrank every other signal', () => {
    expect(detectCaps({ NO_COLOR: '1', COLORTERM: 'truecolor' }, true, 'win32').tier).toBe('mono');
  });

  it('drops to mono when nothing is attached to the output', () => {
    expect(detectCaps({ COLORTERM: 'truecolor' }, false, 'linux').tier).toBe('mono');
  });

  // Without this the coloured paths are unreachable from a test runner, whose
  // stdout is never a TTY.
  it('lets FORCE_COLOR override a missing TTY', () => {
    expect(detectCaps({ FORCE_COLOR: '1' }, false, 'linux').tier).toBe('truecolor');
    expect(detectCaps({ FORCE_COLOR: '0' }, false, 'linux').tier).toBe('mono');
  });

  it('respects a dumb terminal', () => {
    expect(detectCaps({ TERM: 'dumb' }, true, 'linux').tier).toBe('mono');
  });

  it('reads COLORTERM in both spellings', () => {
    expect(detectCaps({ COLORTERM: 'truecolor' }, true, 'linux').tier).toBe('truecolor');
    expect(detectCaps({ COLORTERM: '24bit' }, true, 'linux').tier).toBe('truecolor');
  });

  it('falls back to 256 on a 256-colour TERM', () => {
    expect(detectCaps({ TERM: 'xterm-256color' }, true, 'linux').tier).toBe('ansi256');
  });

  // Windows Terminal does 24-bit but sets neither TERM nor COLORTERM.
  it('assumes truecolor on Windows when nothing says otherwise', () => {
    expect(detectCaps({}, true, 'win32').tier).toBe('truecolor');
    expect(detectCaps({}, true, 'linux').tier).toBe('ansi256');
  });

  it('reports terminal height only when it is a usable number', () => {
    expect(detectCaps({}, true, 'linux', 40).rows).toBe(40);
    expect(detectCaps({}, true, 'linux', 0).rows).toBeNull();
    expect(detectCaps({}, true, 'linux').rows).toBeNull();
  });

  // Width matters as much as height: full-res is 34 columns against the fold's
  // 18, so a narrow pane can be plenty tall and still wrap every line.
  it('reports terminal width only when it is a usable number', () => {
    expect(detectCaps({}, true, 'linux', 40, 120).columns).toBe(120);
    expect(detectCaps({}, true, 'linux', 40, 0).columns).toBeNull();
    expect(detectCaps({}, true, 'linux', 40).columns).toBeNull();
  });
});

describe('frameWidth', () => {
  const grid = gridFor('sprout', 'final', 'night_owl');
  const palette = paletteFor('sprout', 'night_owl');

  it('measures visible columns, not bytes', () => {
    const coloured = renderSpriteFull({ grid, palette, caps: caps('truecolor') });
    const plain = renderSpriteFull({ grid, palette, caps: caps('mono') });
    // Wildly different byte counts, identical geometry.
    expect(coloured.length).toBeGreaterThan(plain.length * 2);
    expect(frameWidth(coloured)).toBe(frameWidth(plain));
  });

  // The numbers the fallback threshold depends on. If either renderer changes
  // shape, this is what says so.
  it('reports the geometry the fallback is choosing between', () => {
    const full = renderSpriteFull({ grid, palette, caps: caps('truecolor') });
    const folded = renderSprite({ grid, palette, caps: caps('truecolor') });

    expect(frameWidth(full)).toBe(2 + SPRITE_SIZE * 2);
    expect(frameWidth(folded)).toBe(2 + SPRITE_SIZE);
    expect(frameWidth(full)).toBeGreaterThan(frameWidth(folded));
  });

  it('handles an empty frame without throwing', () => {
    expect(frameWidth('')).toBe(0);
  });
});

describe('colour arithmetic', () => {
  it('parses hex with and without the hash', () => {
    expect(hexToRgb('#5aa860')).toEqual([90, 168, 96]);
    expect(hexToRgb('5aa860')).toEqual([90, 168, 96]);
    expect(hexToRgb('nope')).toBeNull();
  });

  it('matches the extremes of the cube', () => {
    expect(nearest256([0, 0, 0])).toBe(16);
    expect(nearest256([255, 255, 255])).toBe(231);
  });

  // 0-15 are whatever the user's theme says they are, so matching against them
  // would make the creature change colour with the terminal theme.
  it('never returns a theme-defined index', () => {
    for (let i = 0; i < 500; i++) {
      const rgb: [number, number, number] = [(i * 37) % 256, (i * 91) % 256, (i * 173) % 256];
      const index = nearest256(rgb);
      expect(index, `rgb ${rgb.join(',')}`).toBeGreaterThanOrEqual(16);
      expect(index).toBeLessThanOrEqual(255);
    }
  });

  it('sends mid-grey to the grey ramp', () => {
    expect(nearest256([128, 128, 128])).toBeGreaterThanOrEqual(232);
  });

  it('blends between the two endpoints', () => {
    expect(blend('#000000', '#ffffff', 0)).toBe('#000000');
    expect(blend('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(blend('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  it('clamps a nonsense alpha rather than producing junk', () => {
    expect(blend('#000000', '#ffffff', -5)).toBe('#000000');
    expect(blend('#000000', '#ffffff', 42)).toBe('#ffffff');
  });
});

describe('tintPalette', () => {
  it('leaves a palette untouched when the mood has no overlay', () => {
    expect(tintPalette(SPROUT, 'neutral')).toEqual(SPROUT);
  });

  it('shifts every entry for a mood that does tint, and stays valid hex', () => {
    const tinted = tintPalette(SPROUT, 'sad');
    for (const key of ['0', '1', '2', '3', '4', '5', '6', '7'] as const) {
      expect(tinted[key], `key ${key}`).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(tinted).not.toEqual(SPROUT);
  });

  it('handles every mood without throwing', () => {
    for (const mood of ['happy', 'neutral', 'sad', 'alarmed'] as Mood[]) {
      expect(() => tintPalette(SPROUT, mood)).not.toThrow();
    }
  });
});

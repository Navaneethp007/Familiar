import { describe, expect, it } from 'vitest';

import { formIdentity } from '../src/core/forms.js';
import { BRANCHES } from '../src/core/habits.js';
import { SPECIES } from '../src/core/species.js';
import {
  ADULT_BODIES,
  BRANCH_OVERLAYS,
  blink,
  composite,
  EGG,
  gridFor,
  HATCHLINGS,
  SPRITE_SIZE,
  type Grid,
} from '../src/core/sprites/grids.js';
import { MOOD_TINTS, paletteFor, SPECIES_PALETTES } from '../src/core/sprites/palettes.js';
import type { Stage } from '../src/core/xp.js';

const VALID_CHARS = /^[.0-7 ]+$/;

function expectWellFormed(grid: Grid, label: string): void {
  expect(grid.length, `${label}: row count`).toBe(SPRITE_SIZE);
  grid.forEach((row, y) => {
    expect(row.length, `${label}: row ${y} width — "${row}"`).toBe(SPRITE_SIZE);
    expect(VALID_CHARS.test(row), `${label}: row ${y} characters — "${row}"`).toBe(true);
  });
}

describe('grid data', () => {
  it('has a well-formed egg', () => {
    expectWellFormed(EGG, 'egg');
  });

  it('has a well-formed hatchling for every species', () => {
    for (const species of SPECIES) expectWellFormed(HATCHLINGS[species], `hatchling:${species}`);
  });

  it('has a well-formed adult body for every species', () => {
    for (const species of SPECIES) expectWellFormed(ADULT_BODIES[species], `adult:${species}`);
  });

  it('has a well-formed overlay for every branch', () => {
    for (const branch of BRANCHES) expectWellFormed(BRANCH_OVERLAYS[branch], `overlay:${branch}`);
  });
});

describe('gridFor', () => {
  it('resolves every point in the tree to a well-formed grid', () => {
    const stages: Stage[] = ['egg', 'hatchling', 'final'];
    for (const species of SPECIES) {
      for (const stage of stages) {
        for (const branch of [...BRANCHES, null]) {
          expectWellFormed(gridFor(species, stage, branch), `${species}/${stage}/${branch}`);
        }
      }
    }
  });

  it('produces nine visually distinct final forms', () => {
    const seen = new Set<string>();
    for (const species of SPECIES) {
      for (const branch of BRANCHES) {
        // Shape plus palette is what makes a form distinct, so compare both.
        const grid = gridFor(species, 'final', branch).join('\n');
        const palette = JSON.stringify(paletteFor(species, branch));
        seen.add(`${grid}::${palette}`);
      }
    }
    expect(seen.size).toBe(SPECIES.length * BRANCHES.length);
  });

  it('gives the egg the same shape whatever the species', () => {
    for (const species of SPECIES) {
      expect(gridFor(species, 'egg', null)).toEqual(EGG);
    }
  });
});

describe('composite', () => {
  it('leaves the base untouched under transparent pixels', () => {
    const base = Array.from({ length: SPRITE_SIZE }, () => '1'.repeat(SPRITE_SIZE));
    const overlay = Array.from({ length: SPRITE_SIZE }, () => '.'.repeat(SPRITE_SIZE));
    expect(composite(base, overlay)).toEqual(base);
  });

  it('draws overlay pixels over the base', () => {
    const base = Array.from({ length: SPRITE_SIZE }, () => '1'.repeat(SPRITE_SIZE));
    const overlay = Array.from({ length: SPRITE_SIZE }, () => '4'.repeat(SPRITE_SIZE));
    expect(composite(base, overlay)).toEqual(overlay);
  });
});

describe('blink', () => {
  it('closes the eyes without changing the silhouette', () => {
    for (const species of SPECIES) {
      const open = gridFor(species, 'final', 'night_owl');
      const closed = blink(open);
      expectWellFormed(closed, `blink:${species}`);
      expect(closed.join('')).not.toContain('6');
      // Same number of drawn pixels — only their colour index changed.
      const drawn = (rows: Grid): number => rows.join('').replace(/[.]/g, '').length;
      expect(drawn(closed)).toBe(drawn(open));
    }
  });
});

describe('palettes', () => {
  it('defines a colour for every character a grid can use', () => {
    for (const species of SPECIES) {
      for (const branch of [...BRANCHES, null]) {
        const palette = paletteFor(species, branch);
        const grid = gridFor(species, branch ? 'final' : 'hatchling', branch);
        for (const row of grid) {
          for (const ch of row) {
            if (ch === '.' || ch === ' ') continue;
            expect(palette[ch as keyof typeof palette], `${species}/${branch}: "${ch}"`).toMatch(
              /^#[0-9a-f]{6}$/i,
            );
          }
        }
      }
    }
  });

  it('recolours the accent per branch and leaves the body alone', () => {
    for (const species of SPECIES) {
      const base = SPECIES_PALETTES[species];
      for (const branch of BRANCHES) {
        const palette = paletteFor(species, branch);
        expect(palette['1']).toBe(base['1']);
        expect(palette['4']).not.toBe(base['4']);
      }
    }
  });

  it('has a tint entry for every mood', () => {
    for (const mood of ['happy', 'neutral', 'sad', 'alarmed'] as const) {
      const tint = MOOD_TINTS[mood];
      expect(tint).toBeDefined();
      expect(tint.alpha).toBeGreaterThanOrEqual(0);
      expect(tint.alpha).toBeLessThan(1);
    }
  });
});

describe('formIdentity', () => {
  it('names every combination without repeating a final form name', () => {
    const names = new Set<string>();
    for (const species of SPECIES) {
      for (const branch of BRANCHES) {
        const { name, emoji } = formIdentity(species, 'final', branch);
        expect(name.length).toBeGreaterThan(0);
        expect(emoji.length).toBeGreaterThan(0);
        names.add(name);
      }
    }
    expect(names.size).toBe(SPECIES.length * BRANCHES.length);
  });

  it('falls back rather than crashing on a final form with no branch', () => {
    expect(() => formIdentity('ember', 'final', null)).not.toThrow();
    expect(formIdentity('ember', 'final', null).name.length).toBeGreaterThan(0);
  });
});

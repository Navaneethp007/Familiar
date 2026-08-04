/**
 * What the art has to be, as opposed to what it happens to look like.
 *
 * These encode the monoline redraw's actual requirements — a closed 1px
 * outline, species told apart by shape rather than by palette, branch motifs
 * welded to the body, and eyes that survive being drawn over. Written to fail
 * against the filled-blob art they replaced: turning them green is what "done"
 * means.
 */

import { describe, expect, it } from 'vitest';

import { BRANCHES } from '../src/core/habits.js';
import { SPECIES } from '../src/core/species.js';
import {
  ADULT_BODIES,
  BRANCH_OVERLAYS,
  EGG,
  gridFor,
  HATCHLINGS,
  SPRITE_SIZE,
  type Grid,
} from '../src/core/sprites/grids.js';
import type { Stage } from '../src/core/xp.js';

const opaque = (ch: string | undefined): boolean => ch !== undefined && ch !== '.' && ch !== ' ';
const at = (grid: Grid, x: number, y: number): string | undefined => (grid[y] ?? '')[x];

/** Every body the creature can have, keyed for readable failures. */
function bodies(): Array<[string, Grid]> {
  const out: Array<[string, Grid]> = [['egg', EGG]];
  for (const species of SPECIES) {
    out.push([`hatchling:${species}`, HATCHLINGS[species]]);
    out.push([`adult:${species}`, ADULT_BODIES[species]]);
  }
  return out;
}

describe('the outline is a closed loop', () => {
  // With no fill, the outline *is* the shape. One gap and the creature reads as
  // a broken squiggle. Flood the transparent background in from the border: if
  // anything transparent is unreachable, there is an enclosed interior, which
  // is only possible when the outline closes.
  it('encloses an interior for every body', () => {
    for (const [label, grid] of bodies()) {
      const seen = new Set<number>();
      const queue: Array<[number, number]> = [];

      const push = (x: number, y: number): void => {
        if (x < 0 || y < 0 || x >= SPRITE_SIZE || y >= SPRITE_SIZE) return;
        const key = y * SPRITE_SIZE + x;
        if (seen.has(key) || opaque(at(grid, x, y))) return;
        seen.add(key);
        queue.push([x, y]);
      };

      for (let i = 0; i < SPRITE_SIZE; i++) {
        push(i, 0);
        push(i, SPRITE_SIZE - 1);
        push(0, i);
        push(SPRITE_SIZE - 1, i);
      }

      while (queue.length > 0) {
        const [x, y] = queue.pop() as [number, number];
        push(x + 1, y);
        push(x - 1, y);
        push(x, y + 1);
        push(x, y - 1);
      }

      let transparent = 0;
      for (let y = 0; y < SPRITE_SIZE; y++) {
        for (let x = 0; x < SPRITE_SIZE; x++) if (!opaque(at(grid, x, y))) transparent++;
      }

      expect(transparent - seen.size, `${label}: no enclosed interior — outline is open`).toBeGreaterThan(0);
    }
  });
});

describe('strokes are one pixel wide', () => {
  // The mechanical definition of monoline. A 2x2 block of opaque pixels is a
  // fill, however small.
  it('has no 2x2 solid block in any body', () => {
    for (const [label, grid] of bodies()) {
      for (let y = 0; y < SPRITE_SIZE - 1; y++) {
        for (let x = 0; x < SPRITE_SIZE - 1; x++) {
          const block =
            opaque(at(grid, x, y)) &&
            opaque(at(grid, x + 1, y)) &&
            opaque(at(grid, x, y + 1)) &&
            opaque(at(grid, x + 1, y + 1));
          expect(block, `${label}: solid block at ${x},${y}`).toBe(false);
        }
      }
    }
  });
});

describe('species are told apart by shape', () => {
  const mask = (grid: Grid): string[] =>
    Array.from({ length: SPRITE_SIZE }, (_, y) =>
      Array.from({ length: SPRITE_SIZE }, (_, x) => (opaque(at(grid, x, y)) ? '#' : '.')).join(''),
    );

  const differingRows = (a: Grid, b: Grid): number => {
    const [ma, mb] = [mask(a), mask(b)];
    let n = 0;
    for (let y = 0; y < SPRITE_SIZE; y++) if (ma[y] !== mb[y]) n++;
    return n;
  };

  // The defect this replaces: sprout and ember hatchlings shared 14 of 16 rows,
  // so the species read as a hat rather than a creature. Colour cannot be the
  // differentiator once the user picks it.
  it.each([
    ['hatchling', HATCHLINGS],
    ['adult', ADULT_BODIES],
  ] as const)('%s silhouettes differ in at least 6 rows', (stage, set) => {
    for (let i = 0; i < SPECIES.length; i++) {
      for (let j = i + 1; j < SPECIES.length; j++) {
        const a = SPECIES[i] as (typeof SPECIES)[number];
        const b = SPECIES[j] as (typeof SPECIES)[number];
        expect(differingRows(set[a], set[b]), `${stage}: ${a} vs ${b}`).toBeGreaterThanOrEqual(6);
      }
    }
  });

  it('gives each species a distinct footprint', () => {
    const boxes = new Set<string>();
    for (const stage of ['hatchling', 'final'] as Stage[]) {
      boxes.clear();
      for (const species of SPECIES) {
        const grid = gridFor(species, stage, null);
        let minX = SPRITE_SIZE;
        let maxX = -1;
        let minY = SPRITE_SIZE;
        let maxY = -1;
        let count = 0;
        for (let y = 0; y < SPRITE_SIZE; y++) {
          for (let x = 0; x < SPRITE_SIZE; x++) {
            if (!opaque(at(grid, x, y))) continue;
            count++;
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
          }
        }
        boxes.add(`${maxX - minX}x${maxY - minY}:${count}`);
      }
      expect(boxes.size, `${stage}: species share a footprint`).toBe(SPECIES.length);
    }
  });
});

describe('branch motifs belong to the creature', () => {
  const overlayPixels = (overlay: Grid): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (let y = 0; y < SPRITE_SIZE; y++) {
      for (let x = 0; x < SPRITE_SIZE; x++) if (opaque(at(overlay, x, y))) out.push([x, y]);
    }
    return out;
  };

  // A motif floating in a corner is a sticker. One drawn touching the body
  // welds to it, because composite() overwrites rather than blends.
  it('touches the body for every species and branch', () => {
    for (const species of SPECIES) {
      const body = ADULT_BODIES[species];
      for (const branch of BRANCHES) {
        const overlay = BRANCH_OVERLAYS[branch];
        const touching = overlayPixels(overlay).some(([x, y]) => {
          const neighbours: Array<[number, number]> = [
            [x + 1, y],
            [x - 1, y],
            [x, y + 1],
            [x, y - 1],
          ];
          return neighbours.some(
            ([nx, ny]) => opaque(at(body, nx, ny)) && !opaque(at(overlay, nx, ny)),
          );
        });
        expect(touching, `${species}/${branch}: motif never touches the body`).toBe(true);
      }
    }
  });

  it('carries enough weight to be seen', () => {
    for (const branch of BRANCHES) {
      expect(overlayPixels(BRANCH_OVERLAYS[branch]).length, branch).toBeGreaterThanOrEqual(12);
    }
  });
});

describe('eyes survive everything drawn over them', () => {
  // Blink is a global 6 -> 1 substitution, so an overlay that covers an eye
  // kills blinking for that form silently, with nothing to catch it.
  it('keeps two 2px eyes in every final form', () => {
    for (const species of SPECIES) {
      for (const branch of [...BRANCHES, null]) {
        const grid = gridFor(species, 'final', branch);
        const runs = grid.join('\n').match(/66/g) ?? [];
        expect(runs.length, `${species}/${branch}: expected two 66 eye runs`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('gives hatchlings eyes too', () => {
    for (const species of SPECIES) {
      const runs = HATCHLINGS[species].join('\n').match(/66/g) ?? [];
      expect(runs.length, species).toBeGreaterThanOrEqual(2);
    }
  });
});

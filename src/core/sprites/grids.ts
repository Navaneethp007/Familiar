/**
 * Sprite data: 16×16 character grids, one character per palette index.
 *
 * The art is **monoline** — a closed 1px outline with nothing inside it. That
 * choice is what makes the rest of the file work:
 *
 * 1. **Twenty-one final forms come from three bodies × seven overlays.**
 *    Species owns the silhouette, branch owns the motif and the accent colour,
 *    so every combination differs in both — but only ten grids had to be drawn.
 *    Species must differ by *shape*, not palette, because the palette is now
 *    something the user picks; `tests/sprite-art.test.ts` enforces it.
 * 2. **Animation is computed, not drawn.** Blinking swaps the eye pixels and
 *    idle bob is a CSS transform, so no second frame exists to keep in sync.
 *
 * Two rules the drawing obeys, both from how the terminal renders it: long
 * strokes sit on even rows, because rows `2k` and `2k+1` collapse into one
 * half-block cell and a stroke spanning both reads as a solid blob; and eyes
 * are `66`, two pixels wide, because a single pixel changing shade is invisible
 * once folded.
 */

import type { Branch } from '../habits.js';
import type { Species } from '../species.js';
import type { Stage } from '../xp.js';

export const SPRITE_SIZE = 16;

export type Grid = readonly string[];

/** Transparent. Present in overlays so motifs can sit over a body. */
const _ = '.';

// --- egg -------------------------------------------------------------------

export const EGG: Grid = [
  '................',
  '................',
  '......2222......',
  '.....2....2.....',
  '....2......2....',
  '...2........2...',
  '...2........2...',
  '..2..........2..',
  '..2..........2..',
  '..2..........2..',
  '..2..........2..',
  '...2........2...',
  '...2........2...',
  '....2......2....',
  '.....222222.....',
  '................',
];

// --- hatchlings ------------------------------------------------------------

export const HATCHLINGS: Record<Species, Grid> = {
  // Squat and rooted, with a sprig it has not grown into yet.
  sprout: [
    '................',
    '......3.3.......',
    '.......3........',
    '.....222222.....',
    '....2......2....',
    '...2........2...',
    '...2.66..66.2...',
    '...2........2...',
    '...2..3333..2...',
    '....2......2....',
    '.....222222.....',
    '......3..3......',
    '................',
    '................',
    '................',
    '................',
  ],
  // Already reaching upward, and already tapering to a point.
  ember: [
    '.......33.......',
    '......3..3......',
    '.....222222.....',
    '....2......2....',
    '...2........2...',
    '...2.66..66.2...',
    '...2........2...',
    '...2..3333..2...',
    '....2......2....',
    '.....2....2.....',
    '......2..2......',
    '.......22.......',
    '................',
    '................',
    '................',
    '................',
  ],
  // Wider, floating, already trailing away underneath.
  wisp: [
    '................',
    '....22222222....',
    '...2........2...',
    '..2..........2..',
    '..2..66..66..2..',
    '..2..........2..',
    '..2...3333...2..',
    '..2..........2..',
    '...2........2...',
    '....22222222....',
    '................',
    '.......33.......',
    '................',
    '.....33.........',
    '................',
    '................',
  ],
};

// --- adult bodies ----------------------------------------------------------

export const ADULT_BODIES: Record<Species, Grid> = {
  // Wide and short, standing on the ground it grew out of.
  sprout: [
    '................',
    '......3..3......',
    '.......3........',
    '.......3........',
    '.....222222.....',
    '....2......2....',
    '...2........2...',
    '..2..........2..',
    '..2..66..66..2..',
    '..2..........2..',
    '..2...3333...2..',
    '...2........2...',
    '....2......2....',
    '.....222222.....',
    '.....3....3.....',
    '....33....33....',
  ],
  // Narrow and tall, crowned, tapering to a point that never touches down.
  ember: [
    '.......33.......',
    '......3..3......',
    '.....3....3.....',
    '.....222222.....',
    '....2......2....',
    '...2........2...',
    '...2........2...',
    '...2.66..66.2...',
    '...2........2...',
    '...2..3333..2...',
    '...2........2...',
    '....2......2....',
    '.....2....2.....',
    '......2..2......',
    '.......22.......',
    '................',
  ],
  // The widest of the three, floating, dissolving downward into nothing.
  wisp: [
    '....22222222....',
    '...2........2...',
    '..2..........2..',
    '.2............2.',
    '.2..66....66..2.',
    '.2............2.',
    '.2....3333....2.',
    '.2............2.',
    '..2..........2..',
    '...2........2...',
    '....22222222....',
    '................',
    '.......33.......',
    '................',
    '.....33.........',
    '................',
  ],
};

// --- branch overlays -------------------------------------------------------

/**
 * Drawn over the adult body. `.` leaves the body pixel alone.
 *
 * Every motif is confined to columns 0-3 and 12-15. That is not a style choice
 * — `composite` overwrites rather than blends, and eyes live in columns 4-11,
 * so a motif that strayed inward would erase an eye. Blink is a global `6` → `1`
 * substitution with no notion of position, so it would then fail silently for
 * that one form and nothing would catch it.
 *
 * Each also reaches the body's own outline on all three species, which differ
 * in width — so the motif welds to the creature instead of floating beside it.
 */
export const BRANCH_OVERLAYS: Record<Branch, Grid> = {
  // Ear tufts above, and the same shape again below as a settled roost.
  night_owl: [
    '................',
    '................',
    '................',
    '................',
    '..4..........4..',
    '..44........44..',
    '...4........4...',
    '................',
    '................',
    '...4........4...',
    '..44........44..',
    '..4..........4..',
    '................',
    '................',
    '................',
    '................',
  ],
  // A bracket either side: something held, and held carefully.
  test_guardian: [
    '................',
    '................',
    '................',
    '................',
    '................',
    '.444........444.',
    '.4............4.',
    '.4............4.',
    '.4............4.',
    '.444........444.',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
  ],
  // Heavy bars top and bottom — a brace against the thing that broke.
  firefighter: [
    '................',
    '................',
    '................',
    '................',
    '................',
    '.444........444.',
    '.444........444.',
    '................',
    '................',
    '................',
    '.444........444.',
    '.444........444.',
    '................',
    '................',
    '................',
    '................',
  ],
  // Motion trailing off to the left, thinning as it goes.
  speed_demon: [
    '................',
    '................',
    '................',
    '................',
    '................',
    '444.............',
    '.44.............',
    '................',
    '444.............',
    '.44.............',
    '................',
    '444.............',
    '................',
    '................',
    '................',
    '................',
  ],
  // Scaffolding: structure held up while the inside is rebuilt. It runs the
  // full height on purpose — on the narrow species it stands clear of the body,
  // and on the wide one it replaces the outline it covers, so the last rung has
  // to reach past the widest point to still touch something of the creature.
  refactorer: [
    '................',
    '................',
    '................',
    '................',
    '..4..........4..',
    '..4..........4..',
    '..44........44..',
    '..4..........4..',
    '..4..........4..',
    '..44........44..',
    '..4..........4..',
    '..4..........4..',
    '..44........44..',
    '................',
    '................',
    '................',
  ],
  // A crosshair split around the creature, already lined up.
  one_shot: [
    '................',
    '................',
    '................',
    '................',
    '................',
    '..4..........4..',
    '................',
    '.44..........44.',
    '................',
    '..4..........4..',
    '................',
    '.44..........44.',
    '................',
    '................',
    '................',
    '................',
  ],
  // Sparks of something summoned, above and below.
  conjurer: [
    '................',
    '................',
    '................',
    '..4..........4..',
    '................',
    '.4.4........4.4.',
    '................',
    '..4..........4..',
    '................',
    '................',
    '.4.4........4.4.',
    '................',
    '..4..........4..',
    '................',
    '................',
    '................',
  ],
};

/** Overlays a transparent-aware grid onto a base. */
export function composite(base: Grid, overlay: Grid): string[] {
  const out: string[] = [];
  for (let y = 0; y < SPRITE_SIZE; y++) {
    const baseRow = base[y] ?? _.repeat(SPRITE_SIZE);
    const overlayRow = overlay[y] ?? _.repeat(SPRITE_SIZE);
    let row = '';
    for (let x = 0; x < SPRITE_SIZE; x++) {
      const over = overlayRow[x] ?? _;
      row += over === _ || over === ' ' ? (baseRow[x] ?? _) : over;
    }
    out.push(row);
  }
  return out;
}

/** The grid for any point in the tree. */
export function gridFor(species: Species, stage: Stage, branch: Branch | null): Grid {
  if (stage === 'egg') return EGG;
  if (stage === 'hatchling') return HATCHLINGS[species];
  if (branch === null) return ADULT_BODIES[species];
  return composite(ADULT_BODIES[species], BRANCH_OVERLAYS[branch]);
}

/**
 * Closes the eyes by filling eye pixels with body colour. At 16×16 that reads
 * unmistakably as a blink, and it costs no extra artwork.
 */
export function blink(grid: Grid): string[] {
  return grid.map((row) => row.replace(/6/g, '1'));
}

/**
 * Names and emoji for every form. Three species × three branches = nine final
 * forms, plus a hatchling per species and a shared egg.
 *
 * The point of the matrix is that two people who start the same way still end
 * up with different creatures — that divergence is the shareable hook.
 */

import type { Branch } from './habits.js';
import type { Species } from './species.js';
import type { Stage } from './xp.js';

export const HATCHLING_NAMES: Record<Species, string> = {
  sprout: 'Sproutling',
  ember: 'Emberling',
  wisp: 'Wispling',
};

export const FINAL_NAMES: Record<Species, Record<Branch, string>> = {
  sprout: {
    night_owl: 'Moonleaf',
    test_guardian: 'Wardroot',
    speed_demon: 'Quickvine',
    firefighter: 'Ashbloom',
    refactorer: 'Trellis',
    one_shot: 'Truestem',
    conjurer: 'Covenleaf',
  },
  ember: {
    night_owl: 'Duskcinder',
    test_guardian: 'Forgeward',
    speed_demon: 'Flashspark',
    firefighter: 'Backdraft',
    refactorer: 'Anvilcore',
    one_shot: 'Firstlight',
    conjurer: 'Pactcinder',
  },
  wisp: {
    night_owl: 'Nightlantern',
    test_guardian: 'Wardglimmer',
    speed_demon: 'Blinkwisp',
    firefighter: 'Emberghast',
    refactorer: 'Latticewisp',
    one_shot: 'Clearwisp',
    conjurer: 'Bondlantern',
  },
};

export const SPECIES_EMOJI: Record<Species, string> = {
  sprout: '🌱',
  ember: '🔥',
  wisp: '👻',
};

export const BRANCH_FORM_EMOJI: Record<Branch, string> = {
  night_owl: '🦉',
  test_guardian: '🧪',
  speed_demon: '⚡',
  firefighter: '🔥',
  refactorer: '🛠️',
  one_shot: '🎯',
  conjurer: '🪄',
};

export interface FormIdentity {
  name: string;
  emoji: string;
}

export function formIdentity(species: Species, stage: Stage, branch: Branch | null): FormIdentity {
  if (stage === 'egg') return { name: 'Egg', emoji: '🥚' };
  if (stage === 'hatchling') {
    return { name: HATCHLING_NAMES[species], emoji: '🐣' };
  }
  if (branch === null) {
    // Shouldn't happen — `final` implies a branch — but a surface must never
    // crash on unexpected state, so fall back to the hatchling identity.
    return { name: HATCHLING_NAMES[species], emoji: SPECIES_EMOJI[species] };
  }
  return { name: FINAL_NAMES[species][branch], emoji: BRANCH_FORM_EMOJI[branch] };
}

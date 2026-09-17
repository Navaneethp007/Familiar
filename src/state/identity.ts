/**
 * The evolution a familiar has already earned, kept where a retune cannot move it.
 *
 * Nearly everything about a familiar is re-derived from the event log on every
 * read, which is what lets the XP table and level curve change without a
 * migration. The branch is the exception worth making: it is decided at the
 * moment a threshold is crossed, and moving the threshold moves the moment —
 * which can undo an evolution, or re-run it over a longer history and pick a
 * different creature. So once it exists it is saved beside the settings.
 *
 * Two entry points, because the statusline may never write: `evolutionFor`
 * works the lock out in memory, and `rememberEvolution` saves it.
 */

import type { FamiliarEvent } from '../core/events.js';
import { lockEvolution, type CreatureState, type EvolutionRecord } from '../core/xp.js';
import { readConfig, writeConfig, type FamiliarConfig } from './config.js';

/** The evolution to hand to `deriveState`. Reads nothing, writes nothing. */
export function evolutionFor(
  config: Pick<FamiliarConfig, 'curve' | 'evolution'>,
  events: readonly FamiliarEvent[],
): EvolutionRecord | null {
  return lockEvolution({ evolution: config.evolution, curve: config.curve }, events).evolution;
}

/**
 * Saves the lock, and any evolution `state` has just produced.
 *
 * Re-reads config immediately before writing and touches only its own two
 * fields. A hook reads config at the top, then scans git — which registers
 * repos by rewriting that same file — so writing back the copy from the top
 * would silently un-register whatever the scan just found.
 */
export function rememberEvolution(events: readonly FamiliarEvent[], state: CreatureState): void {
  const config = readConfig();
  if (!config) return;

  const lock = lockEvolution({ evolution: config.evolution, curve: config.curve }, events);
  const evolution: EvolutionRecord | null =
    lock.evolution ??
    (state.branch !== null ? { branch: state.branch, eventKey: state.evolvedOn?.key ?? null } : null);

  const unchanged =
    config.curve === lock.curve &&
    config.evolution?.branch === evolution?.branch &&
    config.evolution?.eventKey === evolution?.eventKey;
  if (unchanged) return;

  writeConfig({ ...config, curve: lock.curve, evolution });
}

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
 * Two entry points, because the statusline may never write: `identityFor`
 * works the lock out in memory, and the `remember*` pair saves it.
 *
 * A *second* evolution is a further departure: it is decided on a sliding
 * window, so unlike the first it cannot be recovered from the log at all. It is
 * observed once and written once, and `rememberReevolution` is where
 * "at most once in a lifetime" is enforced.
 */

import type { FamiliarEvent } from '../core/events.js';
import { lockEvolution, type CreatureState, type EvolutionRecord } from '../core/xp.js';
import { readConfig, writeConfig, type FamiliarConfig } from './config.js';

export interface Identity {
  /** The first evolution. Calibration and bookkeeping; never displayed. */
  evolution: EvolutionRecord | null;
  /** The second, if it has happened. When set, this is the branch in force. */
  reevolution: EvolutionRecord | null;
}

/**
 * Both halves of a familiar's identity, worked out in memory.
 *
 * Reads nothing, writes nothing, and destructures straight into DeriveOptions.
 */
export function identityFor(
  config: Pick<FamiliarConfig, 'curve' | 'evolution' | 'reevolution'>,
  events: readonly FamiliarEvent[],
): Identity {
  const lock = lockEvolution(
    { evolution: config.evolution, reevolution: config.reevolution, curve: config.curve },
    events,
  );
  return { evolution: lock.evolution, reevolution: lock.reevolution };
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

  const lock = lockEvolution(
    { evolution: config.evolution, reevolution: config.reevolution, curve: config.curve },
    events,
  );
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

/**
 * Saves a second evolution, once and only once.
 *
 * The "at most once in a lifetime" rule lives here, at the write, so that no
 * caller can get it wrong: a familiar with one already, or with no first
 * evolution to have grown out of, is refused. Re-reads config immediately
 * before writing for the same reason `rememberEvolution` does — a git scan
 * rewrites that file mid-hook to register repos.
 */
export function rememberReevolution(reevolution: EvolutionRecord): void {
  const config = readConfig();
  if (!config) return;
  if (config.reevolution || !config.evolution) return;

  writeConfig({ ...config, reevolution });
}

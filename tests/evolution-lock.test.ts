import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FamiliarEvent } from '../src/core/events.js';
import {
  CURVE_VERSION,
  deriveState,
  EVOLVE_LEVEL,
  findEvolution,
  LEGACY_EVOLVE_XP,
  lockEvolution,
  totalXpForLevel,
  XP_TABLE,
} from '../src/core/xp.js';
import { defaultConfig, readConfig, registerRepo, writeConfig } from '../src/state/config.js';
import { evolutionFor, rememberEvolution } from '../src/state/identity.js';
import { series, useTempHome } from './helpers.js';

/**
 * Merges worth exactly `xp`, rounded up. Merges keep the arithmetic readable:
 * one event, forty XP, no transitions to reason about.
 */
function mergesWorth(xp: number, start?: Date): FamiliarEvent[] {
  return series('pr_merged', Math.ceil(xp / XP_TABLE.pr_merged), {}, start);
}

/**
 * The band the retune opened up: evolved under the old curve (524 XP), below
 * the new one. 1,000 XP was Lv.22 and final; it is now Lv.12.
 */
const IN_THE_BAND = mergesWorth(1_000);

describe('the retired curve', () => {
  it('is pinned to what the old curve charged for the evolve level', () => {
    expect(LEGACY_EVOLVE_XP).toBe(Math.round(10 * Math.pow(EVOLVE_LEVEL - 1, 1.5)));
  });

  it('really is cheaper than the current one, which is the whole problem', () => {
    expect(LEGACY_EVOLVE_XP).toBeLessThan(totalXpForLevel(EVOLVE_LEVEL));
    expect(deriveState(IN_THE_BAND).level).toBeLessThan(EVOLVE_LEVEL);
  });
});

describe('findEvolution', () => {
  // One algorithm, two places it runs. If they ever disagree, a locked branch
  // and a freshly derived one could name different creatures for the same log.
  it('agrees with the fold on when and into what a familiar evolves', () => {
    const enough = mergesWorth(totalXpForLevel(EVOLVE_LEVEL) + 200);
    const derived = deriveState(enough);
    const found = findEvolution(enough);
    expect(found?.branch).toBe(derived.branch);
    expect(found?.eventKey).toBe(derived.evolvedOn?.key);
  });

  it('finds nothing below the threshold', () => {
    expect(findEvolution(mergesWorth(LEGACY_EVOLVE_XP - 80), LEGACY_EVOLVE_XP)).toBeNull();
  });

  it('can be asked about the retired threshold', () => {
    expect(findEvolution(IN_THE_BAND)).toBeNull();
    expect(findEvolution(IN_THE_BAND, LEGACY_EVOLVE_XP)?.branch).not.toBeUndefined();
  });
});

describe('deriveState with a locked evolution', () => {
  it('keeps the form even below the evolve level', () => {
    const state = deriveState(IN_THE_BAND, {
      evolution: { branch: 'firefighter', eventKey: null },
    });
    expect(state.level).toBeLessThan(EVOLVE_LEVEL);
    expect(state.branch).toBe('firefighter');
    expect(state.stage).toBe('final');
  });

  it('never lets later habits re-decide a locked branch', () => {
    const lots = mergesWorth(totalXpForLevel(EVOLVE_LEVEL) * 3);
    const state = deriveState(lots, { evolution: { branch: 'night_owl', eventKey: null } });
    expect(state.branch).toBe('night_owl');
  });

  it('resolves the moment it evolved from the stored key', () => {
    const key = IN_THE_BAND[5]!.key;
    const state = deriveState(IN_THE_BAND, { evolution: { branch: 'conjurer', eventKey: key } });
    expect(state.evolvedOn?.key).toBe(key);
  });

  it('tolerates a stored key that is no longer in the log', () => {
    const state = deriveState(IN_THE_BAND, { evolution: { branch: 'conjurer', eventKey: 'gone' } });
    expect(state.evolvedOn).toBeNull();
    expect(state.branch).toBe('conjurer');
  });

  it('behaves exactly as before with nothing locked', () => {
    const plain = deriveState(IN_THE_BAND);
    const nulled = deriveState(IN_THE_BAND, { evolution: null });
    expect(nulled.branch).toBe(plain.branch);
    expect(nulled.stage).toBe(plain.stage);
  });
});

describe('lockEvolution', () => {
  it('gives a pre-retune familiar back the form it evolved into', () => {
    const locked = lockEvolution({ evolution: null, curve: 1 }, IN_THE_BAND);
    expect(locked.curve).toBe(CURVE_VERSION);
    expect(locked.evolution).toEqual(findEvolution(IN_THE_BAND, LEGACY_EVOLVE_XP));
    expect(locked.evolution).not.toBeNull();
  });

  it('does not invent an evolution for somebody who never had one', () => {
    const young = mergesWorth(200);
    expect(lockEvolution({ evolution: null, curve: 1 }, young)).toEqual({
      evolution: null,
      curve: CURVE_VERSION,
    });
  });

  // Only a familiar that already existed under the old curve evolved under it.
  // A new one must meet the current threshold, or the retune would be undone
  // for everybody who starts after it.
  it('never applies the retired threshold to a familiar already on the current curve', () => {
    expect(lockEvolution({ evolution: null, curve: CURVE_VERSION }, IN_THE_BAND).evolution).toBeNull();
  });

  it('keeps whatever was already locked', () => {
    const stored = { branch: 'one_shot' as const, eventKey: 'k' };
    expect(lockEvolution({ evolution: stored, curve: 1 }, IN_THE_BAND).evolution).toEqual(stored);
    expect(lockEvolution({ evolution: stored, curve: CURVE_VERSION }, []).evolution).toEqual(stored);
  });
});

describe('the evolution on disk', () => {
  let home: ReturnType<typeof useTempHome>;
  beforeEach(() => {
    home = useTempHome();
  });
  afterEach(() => {
    home.cleanup();
  });

  it('starts a new familiar on the current curve with nothing locked', () => {
    const config = defaultConfig();
    expect(config.curve).toBe(CURVE_VERSION);
    expect(config.evolution).toBeNull();
  });

  it('reads a config from before the retune as the retired curve', () => {
    const { curve: _curve, evolution: _evolution, ...old } = defaultConfig();
    writeConfig(old as never);
    expect(readConfig()?.curve).toBe(1);
    expect(readConfig()?.evolution).toBeNull();
  });

  it('discards a stored branch it does not recognise', () => {
    writeConfig({ ...defaultConfig(), evolution: { branch: 'wizard', eventKey: 'k' } as never });
    expect(readConfig()?.evolution).toBeNull();
  });

  it('works out the lock without writing anything', () => {
    const { curve: _curve, ...old } = defaultConfig();
    writeConfig(old as never);
    const config = readConfig()!;
    expect(evolutionFor(config, IN_THE_BAND)).not.toBeNull();
    expect(readConfig()?.curve).toBe(1);
  });

  it('saves a migrated lock so it survives the next retune', () => {
    const { curve: _curve, ...old } = defaultConfig();
    writeConfig(old as never);
    rememberEvolution(IN_THE_BAND, deriveState(IN_THE_BAND));
    const saved = readConfig();
    expect(saved?.curve).toBe(CURVE_VERSION);
    expect(saved?.evolution?.branch).toBeDefined();
  });

  it('saves an evolution the moment the fold first produces one', () => {
    writeConfig(defaultConfig());
    const enough = mergesWorth(totalXpForLevel(EVOLVE_LEVEL) + 200);
    const state = deriveState(enough);
    rememberEvolution(enough, state);
    expect(readConfig()?.evolution).toEqual({ branch: state.branch, eventKey: state.evolvedOn?.key });
  });

  // scanAll registers repos by rewriting config mid-hook. Saving from a copy
  // read before that would quietly un-register them.
  it('does not clobber anything written to config since the caller read it', () => {
    writeConfig(defaultConfig());
    registerRepo('/somewhere/new');
    const enough = mergesWorth(totalXpForLevel(EVOLVE_LEVEL) + 200);
    rememberEvolution(enough, deriveState(enough));
    expect(readConfig()?.repos).toContain('/somewhere/new');
  });

  it('writes nothing when nothing changed', () => {
    writeConfig(defaultConfig());
    const before = readConfig();
    rememberEvolution(IN_THE_BAND, deriveState(IN_THE_BAND));
    expect(readConfig()).toEqual(before);
  });
});

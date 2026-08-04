import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultConfig, readConfig, writeConfig } from '../src/state/config.js';
import { useTempHome } from './helpers.js';

let home: ReturnType<typeof useTempHome>;

beforeEach(() => {
  home = useTempHome();
});

afterEach(() => {
  home.cleanup();
});

/** Writes a raw config file, bypassing writeConfig's typing. */
function writeRaw(value: unknown): void {
  writeFileSync(join(home.dir, 'config.json'), JSON.stringify(value), 'utf8');
}

describe('reading a config', () => {
  it('returns null when there is nothing to read', () => {
    expect(readConfig()).toBeNull();
  });

  it('round-trips everything it wrote', () => {
    const config = defaultConfig('ember');
    config.tone = 'gremlin';
    config.colour = 'ice';
    config.voice = true;
    writeConfig(config);

    const read = readConfig();
    expect(read?.species).toBe('ember');
    expect(read?.tone).toBe('gremlin');
    expect(read?.colour).toBe('ice');
    expect(read?.voice).toBe(true);
  });

  // The file-by-file rebuild is what makes new fields free: a config written
  // before a field existed simply falls to that field's default.
  it('defaults fields that predate them', () => {
    writeRaw({ version: 1, species: 'wisp', tone: 'zen' });
    const read = readConfig();
    expect(read?.colour).toBeNull();
    expect(read?.voice).toBe(false);
    expect(read?.claudeInstalled).toBe(false);
    expect(read?.repos).toEqual([]);
  });

  it('survives a file that is not valid JSON', () => {
    writeFileSync(join(home.dir, 'config.json'), '{ this is not json', 'utf8');
    expect(readConfig()).toBeNull();
  });
});

describe('validating what it read', () => {
  // A bogus colour would resolve to a palette of `undefined`, and the widget
  // skips any character it cannot colour — an invisible familiar, no error.
  it('rejects a colour it does not recognise', () => {
    writeRaw({ species: 'sprout', colour: 'chartreuse' });
    expect(readConfig()?.colour).toBeNull();
  });

  it('rejects a colour of the wrong type', () => {
    for (const bogus of [42, true, {}, []]) {
      writeRaw({ species: 'sprout', colour: bogus });
      expect(readConfig()?.colour, JSON.stringify(bogus)).toBeNull();
    }
  });

  it('keeps a colour it does recognise', () => {
    writeRaw({ species: 'sprout', colour: 'rose' });
    expect(readConfig()?.colour).toBe('rose');
  });

  it('falls back on an unknown species or tone, exactly as before', () => {
    writeRaw({ species: 'dragon', tone: 'shouty' });
    const read = readConfig();
    expect(read?.species).toBe('sprout');
    expect(read?.tone).toBe('deadpan');
  });

  it('drops non-string entries out of the repo list', () => {
    writeRaw({ species: 'sprout', repos: ['/a', 42, null, '/b'] });
    expect(readConfig()?.repos).toEqual(['/a', '/b']);
  });
});

describe('a fresh config', () => {
  it('starts with no colour, so the species decides', () => {
    expect(defaultConfig('sprout').colour).toBeNull();
  });

  it('starts quiet', () => {
    expect(defaultConfig('sprout').voice).toBe(false);
  });
});

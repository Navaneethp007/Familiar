import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SPEAK_KEYS, TONE_BANKS, TONES } from '../src/core/tone.js';
import {
  sanitiseUtterance,
  speakAloud,
  SPEAK_ENV_VAR,
  voiceCommandFor,
  VOICE_KEYS,
  WINDOWS_SCRIPT,
  type VoiceEnv,
} from '../src/adapters/voice.js';
import { useTempHome } from './helpers.js';

const SCRIPT_PATH = 'C:\\Users\\x\\.familiar\\speak.vbs';

const envFor = (platform: NodeJS.Platform, hasSpdSay = false): VoiceEnv => ({
  platform,
  pathDirs: ['/usr/bin', '/usr/local/bin'],
  exists: (path: string) => hasSpdSay && path.endsWith('spd-say'),
  scriptPath: SCRIPT_PATH,
});

interface Recorded {
  command: string;
  args: string[];
  options: Record<string, unknown>;
  unrefs: number;
}

/** A spawn that records instead of making noise. */
function recorder(): { calls: Recorded[]; spawnFn: never } {
  const calls: Recorded[] = [];
  const spawnFn = (command: string, args: string[], options: Record<string, unknown>) => {
    const call: Recorded = { command, args, options, unrefs: 0 };
    calls.push(call);
    return {
      on: () => undefined,
      unref: () => {
        call.unrefs++;
      },
    };
  };
  return { calls, spawnFn: spawnFn as never };
}

describe('sanitiseUtterance', () => {
  // The real corpus. If someone adds a line with an em-dash or a curly quote,
  // this fails loudly rather than silently mangling it at runtime.
  it('passes every line in every tone bank through unchanged', () => {
    for (const tone of TONES) {
      for (const key of SPEAK_KEYS) {
        for (const line of TONE_BANKS[tone][key]) {
          expect(sanitiseUtterance(line), `${tone}.${key}: "${line}"`).toBe(line);
        }
      }
    }
  });

  it('strips anything that could mean something to a shell or a parser', () => {
    const hostile = `'); Start-Process calc; ('`;
    const clean = sanitiseUtterance(hostile);
    for (const ch of [';', ')', '(', '$', '`', '|', '&', '"']) {
      expect(clean, `contained ${ch}`).not.toContain(ch);
    }
  });

  // `say` and `spd-say` take the utterance as an ordinary argument, so a leading
  // dash would be read as an option instead of spoken.
  it('never returns something that starts with a dash', () => {
    expect(sanitiseUtterance('-v Fred hello').startsWith('-')).toBe(false);
    expect(sanitiseUtterance('--- hi').startsWith('-')).toBe(false);
  });

  it('collapses newlines and control characters into single spaces', () => {
    expect(sanitiseUtterance('a\nb\r\nc')).toBe('a b c');
    expect(sanitiseUtterance('a\u0000b')).toBe('a b');
  });

  it('caps the length so nothing monologues', () => {
    expect(sanitiseUtterance('word '.repeat(200)).length).toBeLessThanOrEqual(120);
  });
});

describe('voiceCommandFor', () => {
  // Detaching a child on Windows leaves it with no console, and powershell.exe
  // cannot run without one — it exits at ~220ms having executed nothing, which
  // made voice silently do nothing on every Windows machine. wscript needs no
  // console, so the same fire-and-forget spawn actually survives.
  it('uses a console-less host on Windows, never powershell', () => {
    const command = voiceCommandFor('merged. it is done.', envFor('win32'));
    expect(command?.command).toBe('wscript.exe');
    expect(command?.command).not.toBe('powershell.exe');
    expect(command?.args).toContain('//B');
    expect(command?.args).toContain(SCRIPT_PATH);
  });

  it('keeps the spoken text out of the script entirely', () => {
    const command = voiceCommandFor('merged. it is done.', envFor('win32'));
    // Only a path is passed; the line itself travels in the environment, so
    // there is no quoting layer that could be got wrong.
    for (const arg of command?.args ?? []) {
      expect(arg).not.toContain('merged');
    }
    expect(command?.env?.[SPEAK_ENV_VAR]).toBe('merged. it is done.');
  });

  it('reads its line from the environment in the script itself', () => {
    expect(WINDOWS_SCRIPT).toContain('SAPI.SpVoice');
    expect(WINDOWS_SCRIPT).toContain(`("${SPEAK_ENV_VAR}")`);
  });

  // wscript reads a .vbs as ANSI, so a stray em-dash in a comment arrives as
  // mojibake. Caught exactly that way the first time this was written.
  it('is pure ASCII, because wscript does not read it as UTF-8', () => {
    const offenders = [...WINDOWS_SCRIPT].filter((ch) => ch.charCodeAt(0) > 127);
    expect(offenders, `non-ASCII: ${offenders.join(' ')}`).toEqual([]);
  });

  it('uses CRLF line endings, as a Windows script host expects', () => {
    expect(WINDOWS_SCRIPT).toContain('\r\n');
    expect(WINDOWS_SCRIPT.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('keeps hostile text out of the argument list', () => {
    const command = voiceCommandFor(`'); calc; ('`, envFor('win32'));
    expect(command?.args).toEqual(['//B', '//Nologo', SCRIPT_PATH]);
  });

  it('passes text as a single argument on macOS', () => {
    expect(voiceCommandFor('fixed it', envFor('darwin'))).toEqual({
      command: 'say',
      args: ['fixed it'],
    });
  });

  it('uses spd-say on linux only when it is actually on PATH', () => {
    expect(voiceCommandFor('hi', envFor('linux', true))?.command).toBe('spd-say');
    expect(voiceCommandFor('hi', envFor('linux', false))).toBeNull();
  });

  it('stays silent on a platform with no known backend', () => {
    expect(voiceCommandFor('hi', envFor('freebsd'))).toBeNull();
  });

  it('stays silent on empty text', () => {
    expect(voiceCommandFor('', envFor('darwin'))).toBeNull();
  });
});

describe('speakAloud', () => {
  let home: ReturnType<typeof useTempHome>;

  beforeEach(() => {
    home = useTempHome();
  });

  afterEach(() => {
    home.cleanup();
  });

  it('spawns detached, silent and hidden, then lets go', () => {
    const { calls, spawnFn } = recorder();
    speakAloud('merged. it is done.', { env: envFor('darwin'), spawnFn });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.options['detached']).toBe(true);
    expect(call.options['stdio']).toBe('ignore');
    expect(call.options['windowsHide']).toBe(true);
    expect(call.unrefs).toBe(1);
  });

  // Without a shell there is no command line for a metacharacter to live on.
  // This is the single most important property in the file.
  it('never asks for a shell', () => {
    const { calls, spawnFn } = recorder();
    speakAloud('hello', { env: envFor('darwin'), spawnFn });
    expect('shell' in calls[0]!.options).toBe(false);
  });

  it('sanitises before spawning', () => {
    const { calls, spawnFn } = recorder();
    speakAloud('-v Fred; calc', { env: envFor('darwin'), spawnFn });
    const spoken = calls[0]?.args[0] ?? '';
    expect(spoken.startsWith('-')).toBe(false);
    expect(spoken).not.toContain(';');
  });

  it('spawns nothing when the machine has no voice', () => {
    const { calls, spawnFn } = recorder();
    speakAloud('hello', { env: envFor('linux', false), spawnFn });
    expect(calls).toHaveLength(0);
  });

  it('swallows a spawn that throws rather than letting it reach a hook', () => {
    const exploding = (() => {
      throw new Error('no such binary');
    }) as never;
    expect(() => speakAloud('hello', { env: envFor('darwin'), spawnFn: exploding })).not.toThrow();
  });
});

describe('VOICE_KEYS', () => {
  it('is a subset of the keys the familiar can speak', () => {
    for (const key of VOICE_KEYS) expect(SPEAK_KEYS).toContain(key);
  });

  // The restraint is the product decision, so it gets a test.
  it('covers only the four moments worth interrupting a room for', () => {
    expect(VOICE_KEYS.size).toBe(4);
    for (const key of ['level_up', 'evolved', 'check_fixed_hard', 'fixed_together'] as const) {
      expect(VOICE_KEYS.has(key)).toBe(true);
    }
    for (const key of ['commit', 'idle', 'tests_passed', 'check_broke'] as const) {
      expect(VOICE_KEYS.has(key)).toBe(false);
    }
  });
});

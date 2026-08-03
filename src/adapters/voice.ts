/**
 * Speaking out loud.
 *
 * Off by default, and deliberately rare when on: four keys out of thirteen. A
 * footer line you can ignore is not the same kind of interruption as a voice in
 * the room, so the same 90-second cooldown that reads as restrained in text
 * would be relentless as audio.
 *
 * Two rules shape everything here:
 *
 * 1. **It must never delay a hook.** Speech is spawned detached and abandoned.
 *    We want nothing back from it — no output, no exit code — so the synchronous
 *    `execFileSync` used everywhere else in this codebase would be strictly
 *    worse: SAPI's Speak() blocks until the sentence finishes, which would stall
 *    the Stop hook for the length of the utterance on every single turn.
 * 2. **It must never speak anything but our own lines.** See sanitiseUtterance.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import type { SpeakKey } from '../core/tone.js';
import { logError } from '../state/config.js';

/**
 * The four moments worth interrupting a room for.
 *
 * `level_up` and `evolved` already bypass the text cooldown in hook.ts, and the
 * two fix keys are the ones that acknowledge a struggle. Everything else —
 * commits especially — would be chatter.
 */
export const VOICE_KEYS: ReadonlySet<SpeakKey> = new Set<SpeakKey>([
  'level_up',
  'evolved',
  'check_fixed_hard',
  'fixed_together',
]);

/** Long enough for any bank line, short enough that nothing monologues. */
const MAX_UTTERANCE = 120;

/**
 * Constrains what can be spoken to a small, known-safe alphabet.
 *
 * Voice only ever says lines from TONE_BANKS, so the safe set is tiny and a
 * whitelist is the honest control: an escape has to be correct for every layer
 * it crosses, a whitelist only has to be correct once.
 *
 * The leading-dash strip is not cosmetic. `say` and `spd-say` take the utterance
 * as an ordinary argument, so a string beginning with `-` would be parsed as an
 * option rather than spoken.
 */
export function sanitiseUtterance(text: string): string {
  return text
    .replace(/[^A-Za-z0-9 ,.!?'-]/g, ' ')
    .replace(/^[-\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_UTTERANCE);
}

export interface VoiceEnv {
  platform: NodeJS.Platform;
  /** Directories from PATH, used to find spd-say without spawning anything. */
  pathDirs: readonly string[];
  exists: (path: string) => boolean;
}

export interface VoiceCommand {
  command: string;
  args: string[];
  /** Extra environment for the child, merged over the parent's. */
  env?: Record<string, string>;
}

/**
 * The PowerShell side, as a fixed literal.
 *
 * The text is passed through the environment rather than interpolated into this
 * string, so no input ever reaches PowerShell's parser and there is nothing to
 * escape. That is a stronger guarantee than quoting correctly, and it costs
 * nothing.
 */
const WINDOWS_SCRIPT = '(New-Object -ComObject SAPI.SpVoice).Speak($env:FAMILIAR_SPEAK)';

/** The env var the script above reads. */
export const SPEAK_ENV_VAR = 'FAMILIAR_SPEAK';

/**
 * Resolves how to speak on this machine. Null means "no voice here" — a silent
 * no-op, never an error, because a missing speech synthesiser is not a problem
 * the user needs telling about mid-session.
 */
export function voiceCommandFor(text: string, env: VoiceEnv): VoiceCommand | null {
  if (text.length === 0) return null;

  switch (env.platform) {
    case 'win32':
      return {
        // -NoProfile is a control, not a speed-up: a user profile can redefine
        // New-Object.
        command: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SCRIPT],
        env: { [SPEAK_ENV_VAR]: text },
      };
    case 'darwin':
      return { command: 'say', args: [text] };
    case 'linux': {
      // Scanning PATH costs a handful of stat calls. Asking `which` would cost a
      // child process, in a hook, which is the entire thing this file avoids.
      const found = env.pathDirs.some((dir) => env.exists(join(dir, 'spd-say')));
      return found ? { command: 'spd-say', args: [text] } : null;
    }
    default:
      return null;
  }
}

/** The real machine, as a VoiceEnv. */
export function realVoiceEnv(): VoiceEnv {
  return {
    platform: process.platform,
    pathDirs: (process.env['PATH'] ?? '').split(delimiter).filter((d) => d.length > 0),
    exists: existsSync,
  };
}

export interface SpeakDeps {
  env?: VoiceEnv;
  spawnFn?: typeof spawn;
}

/**
 * Says something, eventually, somewhere. Returns immediately and never throws.
 *
 * Detaching means giving up reliable error reporting: once the handle is
 * unref'd the parent may exit before an ENOENT surfaces. The listener is
 * attached before unref so most failures are still logged, and best-effort is
 * the right posture for a cosmetic feature inside a process whose first duty is
 * to never break the editor.
 */
export function speakAloud(text: string, deps: SpeakDeps = {}): void {
  try {
    const utterance = sanitiseUtterance(text);
    const command = voiceCommandFor(utterance, deps.env ?? realVoiceEnv());
    if (!command) return;

    const child = (deps.spawnFn ?? spawn)(command.command, command.args, {
      detached: true,
      stdio: 'ignore',
      // Load-bearing: detached on Windows gives the child its own console, which
      // without this flashes a PowerShell window every time the familiar speaks.
      windowsHide: true,
      ...(command.env ? { env: { ...process.env, ...command.env } } : {}),
    });

    child.on('error', (error) => logError('voice:speak', error));
    child.unref();
  } catch (error) {
    logError('voice:speak', error);
  }
}

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
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import type { SpeakKey } from '../core/tone.js';
import { logError } from '../state/config.js';
import { ensureHome } from '../state/log.js';
import { speakScriptPath } from '../state/paths.js';

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
  /** Where the Windows speaker script lives. Unused elsewhere. */
  scriptPath: string;
}

export interface VoiceCommand {
  command: string;
  args: string[];
  /** Extra environment for the child, merged over the parent's. */
  env?: Record<string, string>;
}

/** The env var the Windows script reads its line from. */
export const SPEAK_ENV_VAR = 'FAMILIAR_SPEAK';

/**
 * The Windows speaker, as a script for `wscript.exe`.
 *
 * **Why not PowerShell.** Detaching a child on Windows passes DETACHED_PROCESS,
 * which gives it no console at all — and `powershell.exe` is a console
 * application, so with no console host it exits immediately, code 0, having run
 * nothing. Measured: it dies at ~220ms without reaching its first statement.
 * That made voice silently do nothing on every Windows machine.
 *
 * `wscript.exe` is a windowless host that needs no console, so the same
 * fire-and-forget spawn genuinely survives. Speech is one of the few things
 * that must outlive the process that asked for it, and this is the only way to
 * get that without holding a hook open for the length of the sentence.
 *
 * The text still arrives through the environment rather than being interpolated
 * here, so nothing a caller supplies is ever parsed as code.
 */
export const WINDOWS_SCRIPT = [
  // Pure ASCII, deliberately: wscript reads a .vbs as ANSI, so anything outside
  // it arrives as mojibake. Verified by a test rather than trusted.
  "' Familiar - says one line, then exits. Written by `familiar voice on`.",
  "' The text arrives in an environment variable, never inlined, so there is",
  "' nothing here for a quoting mistake to escape from.",
  'Option Explicit',
  'Dim shell, line, voice',
  'Set shell = CreateObject("WScript.Shell")',
  `line = shell.Environment("PROCESS")("${SPEAK_ENV_VAR}")`,
  'If Len(line) > 0 Then',
  '  Set voice = CreateObject("SAPI.SpVoice")',
  '  voice.Speak line',
  'End If',
  '',
].join('\r\n');

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
        // //B suppresses every dialog, so a broken script can never block
        // waiting for someone to click OK on a machine with no one watching.
        command: 'wscript.exe',
        args: ['//B', '//Nologo', env.scriptPath],
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
    scriptPath: speakScriptPath(),
  };
}

/**
 * Makes sure the speaker script is on disk and current.
 *
 * Rewritten every time rather than only when missing: it is a couple of hundred
 * bytes, and it means an edit to WINDOWS_SCRIPT takes effect on upgrade without
 * anyone having to think about stale files.
 */
function ensureSpeakScript(path: string): boolean {
  try {
    ensureHome();
    // Written via a temp file and renamed, because writeFileSync truncates
    // first: a wscript still reading the previous utterance's copy — or a
    // second hook speaking at the same time — would otherwise be handed a
    // half-written script. rename is atomic on the same volume, so a reader
    // sees either the old file or the new one and never something in between.
    const temp = `${path}.tmp`;
    writeFileSync(temp, WINDOWS_SCRIPT, 'utf8');
    renameSync(temp, path);
    return true;
  } catch (error) {
    logError('voice:script', error);
    return false;
  }
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
    const env = deps.env ?? realVoiceEnv();
    const utterance = sanitiseUtterance(text);
    const command = voiceCommandFor(utterance, env);
    if (!command) return;

    // The Windows speaker is a file on disk rather than an inline argument,
    // because wscript takes a script path. Write it before we need it.
    if (env.platform === 'win32' && !ensureSpeakScript(env.scriptPath)) return;

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

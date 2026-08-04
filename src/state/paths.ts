/**
 * Every path Familiar touches, in one place.
 *
 * FAMILIAR_HOME exists so tests can point the whole state layer at a temp dir
 * instead of stomping on the real `~/.familiar`.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export function familiarHome(): string {
  return process.env['FAMILIAR_HOME'] ?? join(homedir(), '.familiar');
}

export function eventsPath(): string {
  return join(familiarHome(), 'events.jsonl');
}

export function configPath(): string {
  return join(familiarHome(), 'config.json');
}

export function cursorPath(): string {
  return join(familiarHome(), 'cursor.json');
}

/**
 * The spool your shell appends to. Written only by shell profile snippets and
 * only ever read (never rewritten) by Familiar — see adapters/terminal.ts.
 */
export function shellLogPath(): string {
  return join(familiarHome(), 'shell.log');
}

/** Backup of a shell profile, taken before `familiar shell install` edits it. */
export function profileBackupPath(label: string, stamp: string): string {
  return join(familiarHome(), `profile-backup-${label}-${stamp}`);
}

/**
 * A tiny pre-rendered line the statusline reads. Hooks write it; the statusline
 * never does — see the comment in ui/statusline.ts for why.
 */
export function renderCachePath(): string {
  return join(familiarHome(), 'render-cache.json');
}

export function errorLogPath(): string {
  return join(familiarHome(), 'error.log');
}

/**
 * The Windows speaker script. Windows only, and only written when voice is on.
 *
 * It has to be a file because the only host that can speak from a detached
 * process — wscript.exe — takes a script path rather than inline source. See
 * the note in adapters/voice.ts for why PowerShell cannot do this job.
 */
export function speakScriptPath(): string {
  return join(familiarHome(), 'speak.vbs');
}

export function backupPath(stamp: string): string {
  return join(familiarHome(), `settings-backup-${stamp}.json`);
}

/** Claude Code's user-level settings. The only file outside ~/.familiar we write. */
export function claudeSettingsPath(): string {
  return process.env['FAMILIAR_CLAUDE_SETTINGS'] ?? join(homedir(), '.claude', 'settings.json');
}

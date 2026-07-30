/**
 * Installing and removing the shell snippets.
 *
 * This edits the user's shell profile, which is the most invasive thing
 * Familiar does — more so than the Claude Code hooks, which live in one JSON
 * file. So it gets its own command (`familiar shell install`), it is never
 * part of `init`, it backs up first, and it writes a clearly marked block that
 * uninstall can remove exactly.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { ensureHome } from '../state/log.js';
import { profileBackupPath } from '../state/paths.js';
import { BLOCK_END, BLOCK_START, bashSnippet, powershellSnippet } from './snippets.js';

export const SHELLS = ['powershell', 'bash'] as const;
export type ShellName = (typeof SHELLS)[number];

export const SHELL_LABELS: Record<ShellName, string> = {
  powershell: 'PowerShell',
  bash: 'bash',
};

export function profilePathFor(shell: ShellName): string {
  const override = process.env[`FAMILIAR_PROFILE_${shell.toUpperCase()}`];
  if (override) return override;

  if (shell === 'powershell') {
    // Windows PowerShell 5.1's profile location. PowerShell 7 uses
    // "PowerShell" rather than "WindowsPowerShell"; both are handled by the
    // env override above when someone needs the other one.
    const documents = join(homedir(), 'Documents');
    return join(documents, 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1');
  }
  return join(homedir(), '.bashrc');
}

export function snippetFor(shell: ShellName): string {
  return shell === 'powershell' ? powershellSnippet() : bashSnippet();
}

/** Matches our block wherever it sits, so uninstall never guesses at line numbers. */
function blockPattern(): RegExp {
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\r?\\n?${escape(BLOCK_START)}[\\s\\S]*?${escape(BLOCK_END)}\\r?\\n?`, 'g');
}

export function hasBlock(contents: string): boolean {
  return contents.includes(BLOCK_START) && contents.includes(BLOCK_END);
}

export function stripBlock(contents: string): string {
  return contents.replace(blockPattern(), '\n');
}

function readProfile(path: string): string {
  if (!existsSync(path)) return '';
  try {
    const raw = readFileSync(path, 'utf8');
    return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  } catch {
    return '';
  }
}

function backupProfile(path: string, shell: ShellName): string | null {
  if (!existsSync(path)) return null;
  ensureHome();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = shell === 'powershell' ? 'ps1' : 'sh';
  const target = profileBackupPath(shell, `${stamp}.${suffix}`);
  copyFileSync(path, target);
  return target;
}

export interface ShellInstallResult {
  shell: ShellName;
  profilePath: string;
  backup: string | null;
  created: boolean;
  replaced: boolean;
}

/**
 * Writes (or rewrites) the block. Re-running is safe: the old block is removed
 * before the new one is appended, so the profile never accumulates copies and
 * an upgraded snippet replaces the previous one in place.
 */
export function installShell(shell: ShellName): ShellInstallResult {
  const profilePath = profilePathFor(shell);
  const existed = existsSync(profilePath);
  const backup = backupProfile(profilePath, shell);

  const current = readProfile(profilePath);
  const replaced = hasBlock(current);
  const withoutBlock = replaced ? stripBlock(current) : current;

  const body = withoutBlock.replace(/\s*$/, '');
  const next = (body.length > 0 ? `${body}\n\n` : '') + snippetFor(shell) + '\n';

  mkdirSync(dirname(profilePath), { recursive: true });
  writeFileSync(profilePath, next, 'utf8');

  return { shell, profilePath, backup, created: !existed, replaced };
}

export interface ShellUninstallResult {
  shell: ShellName;
  profilePath: string;
  backup: string | null;
  removed: boolean;
}

export function uninstallShell(shell: ShellName): ShellUninstallResult {
  const profilePath = profilePathFor(shell);
  if (!existsSync(profilePath)) {
    return { shell, profilePath, backup: null, removed: false };
  }

  const current = readProfile(profilePath);
  if (!hasBlock(current)) {
    return { shell, profilePath, backup: null, removed: false };
  }

  const backup = backupProfile(profilePath, shell);
  const stripped = stripBlock(current);
  // Restore the file to how it would have looked untouched: same content, one
  // trailing newline, no leftover blank run where our block used to be.
  const cleaned = stripped.replace(/\n{3,}/g, '\n\n').replace(/^\s*\n/, '').replace(/\s*$/, '');
  writeFileSync(profilePath, cleaned.length > 0 ? cleaned + '\n' : '', 'utf8');

  return { shell, profilePath, backup, removed: true };
}

export interface ShellStatus {
  shell: ShellName;
  profilePath: string;
  profileExists: boolean;
  installed: boolean;
}

export function shellStatus(shell: ShellName): ShellStatus {
  const profilePath = profilePathFor(shell);
  const profileExists = existsSync(profilePath);
  return {
    shell,
    profilePath,
    profileExists,
    installed: profileExists && hasBlock(readProfile(profilePath)),
  };
}

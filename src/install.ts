/**
 * Wiring Familiar into `~/.claude/settings.json`.
 *
 * This is the only file outside `~/.familiar` that Familiar ever writes, and it
 * is the user's live configuration. So: back it up first, deep-merge rather
 * than overwrite, refuse to clobber an existing statusLine without --force, and
 * make `uninstall` remove exactly what was added and nothing else.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureHome } from './state/log.js';
import { backupPath, claudeSettingsPath } from './state/paths.js';

/** Absolute path of the built CLI entrypoint, with forward slashes for portability. */
export function cliEntrypoint(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, 'cli.js').replace(/\\/g, '/');
}

/**
 * Whether this copy is running from a throwaway cache rather than an install.
 *
 * `npx`, `pnpm dlx` and friends unpack into a directory they later prune. That
 * is fine for a command that only reads — but wiring hooks records this exact
 * path into `~/.claude/settings.json`, and once the cache is cleared all four
 * hooks and the statusline point at a file that no longer exists. The symptom
 * is Claude Code appearing to misbehave, with nothing naming Familiar as the
 * cause, which is the worst kind of failure this project can produce.
 */
export function isEphemeralEntrypoint(path: string = cliEntrypoint()): boolean {
  // `_npx` is a whole path segment; pnpm's is `dlx-<hash>`, so that one matches
  // a segment *starting* with the prefix rather than equalling it.
  return /[\\/](_npx[\\/]|dlx-[^\\/]*[\\/]|\.pnpm-store[\\/])/i.test(path);
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

interface HookHandler {
  type: string;
  command?: string;
  args?: string[];
  timeout?: number;
  [key: string]: unknown;
}

interface HookGroup {
  matcher?: string;
  hooks: HookHandler[];
  [key: string]: unknown;
}

interface ClaudeSettings {
  statusLine?: { type?: string; command?: string; [key: string]: unknown };
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

/** Events we hook, and the matcher each one needs. */
const HOOK_EVENTS: Array<{ event: string; matcher?: string }> = [
  { event: 'SessionStart', matcher: 'startup|resume' },
  { event: 'PostToolUse', matcher: 'Bash' },
  { event: 'Stop' },
  { event: 'SessionEnd' },
];

function handlerFor(cliPath: string, event: string): HookHandler {
  return {
    type: 'command',
    // Exec form (command + args) rather than a shell string: no quoting rules
    // to get wrong, which matters most on Windows.
    command: 'node',
    args: [cliPath, 'hook', `--event=${event}`],
    timeout: 10,
  };
}

/** Identifies a hook handler as one of ours, so uninstall removes only those. */
function isOurs(handler: HookHandler, cliPath: string): boolean {
  const args = handler.args;
  if (!Array.isArray(args)) return false;
  if (args.includes(cliPath)) return true;
  // Tolerate a moved or reinstalled checkout.
  return args.some((a) => typeof a === 'string' && /familiar[\\/].*cli\.js$/i.test(a));
}

export function readSettings(path = claudeSettingsPath()): ClaudeSettings {
  if (!existsSync(path)) return {};
  try {
    // Plenty of Windows editors (and PowerShell's Out-File) write a UTF-8 BOM.
    // JSON.parse rejects it, and refusing to install over a perfectly valid
    // settings file because of an invisible byte would be a baffling failure.
    return JSON.parse(stripBom(readFileSync(path, 'utf8'))) as ClaudeSettings;
  } catch {
    // Refuse to guess at a malformed settings file — overwriting it would be
    // far worse than declining to install.
    throw new Error(`Could not parse ${path}. Fix or move it, then re-run.`);
  }
}

function writeSettings(settings: ClaudeSettings, path = claudeSettingsPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

export function backupSettings(path = claudeSettingsPath()): string | null {
  if (!existsSync(path)) return null;
  ensureHome();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = backupPath(stamp);
  copyFileSync(path, target);
  return target;
}

export interface InstallResult {
  backup: string | null;
  hooksAdded: string[];
  statusLineInstalled: boolean;
  statusLineSkipped: boolean;
  settingsPath: string;
}

export interface InstallOptions {
  force?: boolean;
  cliPath?: string;
  settingsPath?: string;
}

export function installClaudeIntegration(options: InstallOptions = {}): InstallResult {
  const settingsPath = options.settingsPath ?? claudeSettingsPath();
  const cliPath = options.cliPath ?? cliEntrypoint();

  const settings = readSettings(settingsPath);
  const backup = backupSettings(settingsPath);

  const hooks: Record<string, HookGroup[]> = { ...(settings.hooks ?? {}) };
  const hooksAdded: string[] = [];

  for (const { event, matcher } of HOOK_EVENTS) {
    const groups: HookGroup[] = [...(hooks[event] ?? [])];

    // Drop any previous Familiar handler for this event so re-running init
    // upgrades the path in place instead of stacking duplicates.
    const cleaned = groups
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((h) => !isOurs(h, cliPath)) }))
      .filter((group) => group.hooks.length > 0);

    const handler = handlerFor(cliPath, event);
    const target = cleaned.find((g) => (g.matcher ?? '') === (matcher ?? ''));
    if (target) {
      target.hooks.push(handler);
    } else {
      cleaned.push(matcher ? { matcher, hooks: [handler] } : { hooks: [handler] });
    }

    hooks[event] = cleaned;
    hooksAdded.push(event);
  }

  let statusLineInstalled = false;
  let statusLineSkipped = false;

  const existingStatusLine = settings.statusLine;
  const existingIsOurs =
    typeof existingStatusLine?.command === 'string' &&
    existingStatusLine.command.includes(cliPath);

  if (existingStatusLine && !existingIsOurs && !options.force) {
    statusLineSkipped = true;
  } else {
    settings.statusLine = {
      type: 'command',
      command: `node "${cliPath}" statusline`,
      padding: 0,
    };
    statusLineInstalled = true;
  }

  settings.hooks = hooks;
  writeSettings(settings, settingsPath);

  return { backup, hooksAdded, statusLineInstalled, statusLineSkipped, settingsPath };
}

export interface UninstallResult {
  backup: string | null;
  hooksRemoved: number;
  statusLineRemoved: boolean;
  settingsPath: string;
}

export function uninstallClaudeIntegration(options: InstallOptions = {}): UninstallResult {
  const settingsPath = options.settingsPath ?? claudeSettingsPath();
  const cliPath = options.cliPath ?? cliEntrypoint();

  if (!existsSync(settingsPath)) {
    return { backup: null, hooksRemoved: 0, statusLineRemoved: false, settingsPath };
  }

  const settings = readSettings(settingsPath);
  const backup = backupSettings(settingsPath);

  let hooksRemoved = 0;
  if (settings.hooks) {
    const hooks: Record<string, HookGroup[]> = {};
    for (const [event, groups] of Object.entries(settings.hooks)) {
      const cleaned = (groups ?? [])
        .map((group) => {
          const kept = (group.hooks ?? []).filter((h) => {
            const ours = isOurs(h, cliPath);
            if (ours) hooksRemoved++;
            return !ours;
          });
          return { ...group, hooks: kept };
        })
        .filter((group) => group.hooks.length > 0);

      // Drop the event key entirely if we were the only thing in it, so the
      // file ends up the way we found it rather than littered with empties.
      if (cleaned.length > 0) hooks[event] = cleaned;
    }
    if (Object.keys(hooks).length > 0) settings.hooks = hooks;
    else delete settings.hooks;
  }

  let statusLineRemoved = false;
  if (
    typeof settings.statusLine?.command === 'string' &&
    /familiar/i.test(settings.statusLine.command)
  ) {
    delete settings.statusLine;
    statusLineRemoved = true;
  }

  writeSettings(settings, settingsPath);
  return { backup, hooksRemoved, statusLineRemoved, settingsPath };
}

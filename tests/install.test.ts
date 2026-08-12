import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  installClaudeIntegration,
  isEphemeralEntrypoint,
  readSettings,
  uninstallClaudeIntegration,
} from '../src/install.js';
import { tempDir, useTempHome } from './helpers.js';

let home: ReturnType<typeof useTempHome>;
let settingsPath: string;

const CLI = 'C:/Users/test/Familiar/dist/cli.js';

/** Mirrors the real user settings: unrelated keys that must survive untouched. */
const EXISTING = {
  env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
  enabledPlugins: { 'superpowers@claude-plugins-official': true },
  effortLevel: 'medium',
  tui: 'fullscreen',
  voice: { enabled: true, mode: 'hold' },
};

function write(value: unknown): void {
  writeFileSync(settingsPath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function read(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  home = useTempHome();
  settingsPath = join(tempDir('familiar-settings-'), 'settings.json');
  process.env['FAMILIAR_CLAUDE_SETTINGS'] = settingsPath;
});

afterEach(() => {
  delete process.env['FAMILIAR_CLAUDE_SETTINGS'];
  home.cleanup();
});

describe('install', () => {
  it('preserves every unrelated key', () => {
    write(EXISTING);
    installClaudeIntegration({ cliPath: CLI, settingsPath });

    const after = read();
    for (const [key, value] of Object.entries(EXISTING)) {
      expect(after[key], key).toEqual(value);
    }
  });

  it('backs the file up before touching it', () => {
    write(EXISTING);
    const result = installClaudeIntegration({ cliPath: CLI, settingsPath });

    expect(result.backup).not.toBeNull();
    expect(existsSync(result.backup!)).toBe(true);
    expect(JSON.parse(readFileSync(result.backup!, 'utf8'))).toEqual(EXISTING);
  });

  it('installs hooks for every wired event', () => {
    write(EXISTING);
    const result = installClaudeIntegration({ cliPath: CLI, settingsPath });

    const hooks = read()['hooks'] as Record<string, unknown[]>;
    for (const event of ['SessionStart', 'PostToolUse', 'Stop', 'SessionEnd']) {
      expect(hooks[event], event).toBeDefined();
    }
    expect(result.hooksAdded).toEqual(['SessionStart', 'PostToolUse', 'Stop', 'SessionEnd']);
  });

  it('uses the exec form so nothing depends on shell quoting', () => {
    write(EXISTING);
    installClaudeIntegration({ cliPath: CLI, settingsPath });

    const hooks = read()['hooks'] as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
    const handler = hooks['SessionStart']?.[0]?.hooks?.[0];
    expect(handler?.['type']).toBe('command');
    expect(handler?.['command']).toBe('node');
    expect(handler?.['args']).toEqual([CLI, 'hook', '--event=SessionStart']);
  });

  it('installs the statusline when there is none', () => {
    write(EXISTING);
    const result = installClaudeIntegration({ cliPath: CLI, settingsPath });

    expect(result.statusLineInstalled).toBe(true);
    expect(result.statusLineSkipped).toBe(false);
    expect((read()['statusLine'] as { command: string }).command).toContain(CLI);
  });

  it('refuses to replace an existing statusline', () => {
    write({ ...EXISTING, statusLine: { type: 'command', command: 'my-own-script.sh' } });
    const result = installClaudeIntegration({ cliPath: CLI, settingsPath });

    expect(result.statusLineSkipped).toBe(true);
    expect(result.statusLineInstalled).toBe(false);
    expect((read()['statusLine'] as { command: string }).command).toBe('my-own-script.sh');
  });

  it('replaces an existing statusline when forced', () => {
    write({ ...EXISTING, statusLine: { type: 'command', command: 'my-own-script.sh' } });
    const result = installClaudeIntegration({ cliPath: CLI, settingsPath, force: true });

    expect(result.statusLineInstalled).toBe(true);
    expect((read()['statusLine'] as { command: string }).command).toContain(CLI);
  });

  it('leaves someone else\u2019s hooks alone', () => {
    write({
      ...EXISTING,
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'their-guard.sh' }] }],
        SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'their-init.sh' }] }],
      },
    });
    installClaudeIntegration({ cliPath: CLI, settingsPath });

    const hooks = read()['hooks'] as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
    expect(JSON.stringify(hooks['PreToolUse'])).toContain('their-guard.sh');
    expect(JSON.stringify(hooks['SessionStart'])).toContain('their-init.sh');
    expect(JSON.stringify(hooks['SessionStart'])).toContain('--event=SessionStart');
  });

  it('does not stack duplicates when run twice', () => {
    write(EXISTING);
    installClaudeIntegration({ cliPath: CLI, settingsPath });
    installClaudeIntegration({ cliPath: CLI, settingsPath });
    installClaudeIntegration({ cliPath: CLI, settingsPath });

    const serialised = JSON.stringify(read()['hooks']);
    const occurrences = serialised.split('--event=SessionStart').length - 1;
    expect(occurrences).toBe(1);
  });

  it('works when no settings file exists yet', () => {
    const result = installClaudeIntegration({ cliPath: CLI, settingsPath });
    expect(result.backup).toBeNull();
    expect(existsSync(settingsPath)).toBe(true);
    expect(read()['hooks']).toBeDefined();
  });

  it('reads a settings file that starts with a UTF-8 BOM', () => {
    // PowerShell's Out-File and several Windows editors add one. Refusing to
    // install over valid settings because of an invisible byte is unacceptable.
    writeFileSync(settingsPath, '﻿' + JSON.stringify(EXISTING, null, 2), 'utf8');

    expect(() => installClaudeIntegration({ cliPath: CLI, settingsPath })).not.toThrow();
    const after = read();
    expect(after['effortLevel']).toBe('medium');
    expect(after['hooks']).toBeDefined();
  });

  it('refuses to guess at a malformed settings file', () => {
    writeFileSync(settingsPath, '{ this is not json', 'utf8');
    expect(() => installClaudeIntegration({ cliPath: CLI, settingsPath })).toThrow(/parse/i);
    // And it left the broken file exactly as it found it.
    expect(readFileSync(settingsPath, 'utf8')).toBe('{ this is not json');
  });
});

describe('uninstall', () => {
  it('restores the settings to their pre-install state', () => {
    write(EXISTING);
    installClaudeIntegration({ cliPath: CLI, settingsPath });
    uninstallClaudeIntegration({ cliPath: CLI, settingsPath });

    expect(read()).toEqual(EXISTING);
  });

  it('removes only our hooks', () => {
    const theirs = {
      ...EXISTING,
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'their-guard.sh' }] }] },
    };
    write(theirs);
    installClaudeIntegration({ cliPath: CLI, settingsPath });
    const result = uninstallClaudeIntegration({ cliPath: CLI, settingsPath });

    expect(result.hooksRemoved).toBe(4);
    expect(result.statusLineRemoved).toBe(true);
    expect(read()).toEqual(theirs);
  });

  it('leaves a foreign statusline in place', () => {
    const theirs = { ...EXISTING, statusLine: { type: 'command', command: 'my-own-script.sh' } };
    write(theirs);
    installClaudeIntegration({ cliPath: CLI, settingsPath });
    uninstallClaudeIntegration({ cliPath: CLI, settingsPath });

    expect(read()).toEqual(theirs);
  });

  it('is a no-op when there is nothing installed', () => {
    const result = uninstallClaudeIntegration({ cliPath: CLI, settingsPath });
    expect(result.hooksRemoved).toBe(0);
    expect(result.statusLineRemoved).toBe(false);
  });

  it('backs up before removing, too', () => {
    write(EXISTING);
    installClaudeIntegration({ cliPath: CLI, settingsPath });
    uninstallClaudeIntegration({ cliPath: CLI, settingsPath });

    const backups = readdirSync(home.dir).filter((f) => f.startsWith('settings-backup-'));
    expect(backups.length).toBeGreaterThanOrEqual(2);
  });
});

describe('readSettings', () => {
  it('treats a missing file as empty', () => {
    expect(readSettings(join(home.dir, 'nope.json'))).toEqual({});
  });
});

describe('running from a throwaway cache', () => {
  // npx unpacks into a directory it later prunes. Wiring records an absolute
  // path, so hooks installed from there break silently once the cache clears —
  // and the symptom looks like Claude Code misbehaving, with nothing naming
  // Familiar as the cause.
  it('recognises the caches that get pruned', () => {
    const ephemeral = [
      'C:/Users/x/AppData/Local/npm-cache/_npx/a1b2/node_modules/witch-familiar/dist/cli.js',
      '/home/x/.npm/_npx/9f3/node_modules/witch-familiar/dist/cli.js',
      '/tmp/dlx-12345/node_modules/witch-familiar/dist/cli.js',
    ];
    for (const path of ephemeral) {
      expect(isEphemeralEntrypoint(path), path).toBe(true);
    }
  });

  it('leaves a real installation alone', () => {
    const durable = [
      'C:/Users/x/AppData/Roaming/npm/node_modules/witch-familiar/dist/cli.js',
      '/usr/local/lib/node_modules/witch-familiar/dist/cli.js',
      'C:/Users/nvps7/Familiar/dist/cli.js',
      '/home/x/projects/Familiar/dist/cli.js',
    ];
    for (const path of durable) {
      expect(isEphemeralEntrypoint(path), path).toBe(false);
    }
  });
});

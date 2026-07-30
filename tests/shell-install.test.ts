import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  hasBlock,
  installShell,
  profilePathFor,
  shellStatus,
  SHELLS,
  snippetFor,
  stripBlock,
  uninstallShell,
  type ShellName,
} from '../src/shell/install.js';
import { BLOCK_END, BLOCK_START } from '../src/shell/snippets.js';
import { tempDir, useTempHome } from './helpers.js';

let home: ReturnType<typeof useTempHome>;
let profileDir: string;

const EXISTING_PS = `# my prompt
function prompt { "PS> " }
Set-Alias ll Get-ChildItem
`;

const EXISTING_BASH = `export PATH="$HOME/bin:$PATH"
alias ll='ls -la'
`;

function profileFor(shell: ShellName): string {
  return profilePathFor(shell);
}

beforeEach(() => {
  home = useTempHome();
  profileDir = tempDir('familiar-profile-');
  process.env['FAMILIAR_PROFILE_POWERSHELL'] = join(profileDir, 'profile.ps1');
  process.env['FAMILIAR_PROFILE_BASH'] = join(profileDir, '.bashrc');
});

afterEach(() => {
  delete process.env['FAMILIAR_PROFILE_POWERSHELL'];
  delete process.env['FAMILIAR_PROFILE_BASH'];
  home.cleanup();
});

describe.each(SHELLS)('%s profile', (shell) => {
  const existing = shell === 'powershell' ? EXISTING_PS : EXISTING_BASH;

  it('creates the profile when there is none', () => {
    const result = installShell(shell);
    expect(result.created).toBe(true);
    expect(existsSync(result.profilePath)).toBe(true);
    expect(hasBlock(readFileSync(result.profilePath, 'utf8'))).toBe(true);
  });

  it('preserves everything that was already there', () => {
    writeFileSync(profileFor(shell), existing, 'utf8');
    installShell(shell);

    const after = readFileSync(profileFor(shell), 'utf8');
    for (const original of existing.trim().split('\n')) {
      expect(after, original).toContain(original);
    }
  });

  it('backs up before editing', () => {
    writeFileSync(profileFor(shell), existing, 'utf8');
    const result = installShell(shell);

    expect(result.backup).not.toBeNull();
    expect(readFileSync(result.backup!, 'utf8')).toBe(existing);
  });

  it('does not stack copies when run repeatedly', () => {
    writeFileSync(profileFor(shell), existing, 'utf8');
    installShell(shell);
    installShell(shell);
    installShell(shell);

    const after = readFileSync(profileFor(shell), 'utf8');
    expect(after.split(BLOCK_START).length - 1).toBe(1);
    expect(after.split(BLOCK_END).length - 1).toBe(1);
  });

  it('reports a re-run as a replacement', () => {
    installShell(shell);
    expect(installShell(shell).replaced).toBe(true);
  });

  it('restores the profile exactly on uninstall', () => {
    writeFileSync(profileFor(shell), existing, 'utf8');
    installShell(shell);
    const result = uninstallShell(shell);

    expect(result.removed).toBe(true);
    expect(readFileSync(profileFor(shell), 'utf8')).toBe(existing);
  });

  it('leaves an untouched profile alone', () => {
    writeFileSync(profileFor(shell), existing, 'utf8');
    const result = uninstallShell(shell);

    expect(result.removed).toBe(false);
    expect(readFileSync(profileFor(shell), 'utf8')).toBe(existing);
  });

  it('is a no-op when no profile exists', () => {
    expect(uninstallShell(shell).removed).toBe(false);
  });

  it('reports status accurately', () => {
    expect(shellStatus(shell).installed).toBe(false);
    installShell(shell);
    expect(shellStatus(shell).installed).toBe(true);
    uninstallShell(shell);
    expect(shellStatus(shell).installed).toBe(false);
  });

  it('handles a profile saved with a BOM', () => {
    writeFileSync(profileFor(shell), '﻿' + existing, 'utf8');
    expect(() => installShell(shell)).not.toThrow();
    expect(hasBlock(readFileSync(profileFor(shell), 'utf8'))).toBe(true);
  });
});

describe('the snippets themselves', () => {
  it.each(SHELLS)('%s is delimited so uninstall can find it', (shell) => {
    const snippet = snippetFor(shell);
    expect(snippet.startsWith(BLOCK_START)).toBe(true);
    expect(snippet.trimEnd().endsWith(BLOCK_END)).toBe(true);
  });

  it.each(SHELLS)('%s launches no external program', (shell) => {
    // This runs after every command you type. Spawning anything would add
    // 60-100ms to every prompt, which is how a toy gets uninstalled.
    const snippet = snippetFor(shell);
    expect(snippet).not.toMatch(/\bnode\b/);
    expect(snippet).not.toMatch(/\bnpx\b/);
    expect(snippet).not.toMatch(/\bfamiliar\s+(hook|status)/);
  });

  it('powershell restores the exit code it captured', () => {
    const snippet = snippetFor('powershell');
    expect(snippet).toContain('$__familiarCode = $LASTEXITCODE');
    expect(snippet).toContain('$global:LASTEXITCODE = $__familiarCode');
  });

  it('bash returns the exit code it captured', () => {
    const snippet = snippetFor('bash');
    expect(snippet).toContain('local __code=$?');
    expect(snippet).toContain('return $__code');
  });

  it('bash refuses to install itself twice into PROMPT_COMMAND', () => {
    expect(snippetFor('bash')).toContain('*__familiar_report*');
  });

  it('powershell guards against re-sourcing the profile', () => {
    // Without this, re-sourcing wraps our own prompt and recurses forever.
    expect(snippetFor('powershell')).toContain('if (-not $global:__familiarInstalled)');
  });
});

describe('stripBlock', () => {
  it('removes the block and nothing else', () => {
    const before = `line one\n${BLOCK_START}\nstuff\n${BLOCK_END}\nline two\n`;
    const after = stripBlock(before);
    expect(after).toContain('line one');
    expect(after).toContain('line two');
    expect(after).not.toContain(BLOCK_START);
    expect(after).not.toContain('stuff');
  });

  it('leaves content with no block untouched', () => {
    expect(stripBlock('nothing to see\n')).toBe('nothing to see\n');
  });
});

describe('backups', () => {
  it('accumulate rather than overwrite', () => {
    writeFileSync(profileFor('bash'), EXISTING_BASH, 'utf8');
    installShell('bash');
    uninstallShell('bash');

    const backups = readdirSync(home.dir).filter((f) => f.startsWith('profile-backup-'));
    expect(backups.length).toBeGreaterThanOrEqual(2);
  });
});

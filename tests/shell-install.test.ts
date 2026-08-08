import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  hasBlock,
  installShell,
  profilePathFor,
  shellPresent,
  shellStatus,
  SHELLS,
  snippetFor,
  stripBlock,
  uninstallShell,
  type ShellName,
} from '../src/shell/install.js';
import type { PolicyProbe } from '../src/shell/policy.js';
import { BLOCK_END, BLOCK_START } from '../src/shell/snippets.js';
import { tempDir, useTempHome } from './helpers.js';

/**
 * A policy probe that answers instantly and counts how often it was asked.
 *
 * Every shellStatus call in this file passes one. Without it the real probe
 * spawns PowerShell, which is slow and makes the result depend on whatever
 * policy the machine running the tests happens to have.
 */
function countingProbe(
  output: string | null,
  platform: NodeJS.Platform = 'win32',
): { probe: PolicyProbe; count: () => number } {
  let calls = 0;
  return {
    count: () => calls,
    probe: {
      platform,
      env: {},
      run: () => {
        calls++;
        return output;
      },
    },
  };
}

const PERMISSIVE = countingProbe('RemoteSigned').probe;

let home: ReturnType<typeof useTempHome>;
let profileDir: string;

const EXISTING_PS = `# my prompt
function prompt { "PS> " }
Set-Alias ll Get-ChildItem
`;

const EXISTING_BASH = `export PATH="$HOME/bin:$PATH"
alias ll='ls -la'
`;

const EXISTING_ZSH = `export PATH="$HOME/bin:$PATH"
autoload -Uz compinit && compinit
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
  process.env['FAMILIAR_PROFILE_ZSH'] = join(profileDir, '.zshrc');
  process.env['FAMILIAR_PROFILE_PWSH'] = join(profileDir, 'pwsh-profile.ps1');
});

afterEach(() => {
  delete process.env['FAMILIAR_PROFILE_POWERSHELL'];
  delete process.env['FAMILIAR_PROFILE_BASH'];
  delete process.env['FAMILIAR_PROFILE_ZSH'];
  delete process.env['FAMILIAR_PROFILE_PWSH'];
  home.cleanup();
});

describe.each(SHELLS)('%s profile', (shell) => {
  const existing =
    shell === 'powershell' || shell === 'pwsh'
      ? EXISTING_PS
      : shell === 'zsh'
        ? EXISTING_ZSH
        : EXISTING_BASH;

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
    expect(shellStatus(shell, PERMISSIVE).installed).toBe(false);
    installShell(shell);
    expect(shellStatus(shell, PERMISSIVE).installed).toBe(true);
    uninstallShell(shell);
    expect(shellStatus(shell, PERMISSIVE).installed).toBe(false);
  });

  it('handles a profile saved with a BOM', () => {
    writeFileSync(profileFor(shell), '﻿' + existing, 'utf8');
    expect(() => installShell(shell)).not.toThrow();
    expect(hasBlock(readFileSync(profileFor(shell), 'utf8'))).toBe(true);
  });

  // Leaving an empty file behind is not harmless on Windows: the signature of a
  // profile is checked before it is read, so a zero-byte unsigned .ps1 still
  // raises a security error on every shell launch. Uninstall has to undo the
  // install, not just blank it.
  it('deletes a profile it created, rather than emptying it', () => {
    installShell(shell);
    expect(existsSync(profileFor(shell))).toBe(true);

    expect(uninstallShell(shell).removed).toBe(true);
    expect(existsSync(profileFor(shell))).toBe(false);
  });

  it('still takes a backup on the delete path', () => {
    installShell(shell);
    const result = uninstallShell(shell);
    expect(result.backup).not.toBeNull();
    expect(existsSync(result.backup as string)).toBe(true);
  });

  it('never deletes a profile that had anything of the user in it', () => {
    writeFileSync(profileFor(shell), existing, 'utf8');
    installShell(shell);
    uninstallShell(shell);

    expect(existsSync(profileFor(shell))).toBe(true);
    expect(readFileSync(profileFor(shell), 'utf8')).toBe(existing);
  });
});

describe('whether the profile can actually load', () => {
  it('reports a blocking policy so the CLI can warn about it', () => {
    installShell('powershell');
    const { probe } = countingProbe('Restricted');
    const status = shellStatus('powershell', probe);

    expect(status.installed).toBe(true);
    expect(status.loadVerdict).toBe('blocked');
    expect(status.policy).toBe('Restricted');
  });

  it('reports a permissive policy as fine', () => {
    installShell('powershell');
    const status = shellStatus('powershell', countingProbe('RemoteSigned').probe);
    expect(status.loadVerdict).toBe('ok');
    expect(status.policy).toBe('RemoteSigned');
  });

  it('says unknown rather than guessing when the probe cannot answer', () => {
    installShell('powershell');
    const status = shellStatus('powershell', countingProbe(null).probe);
    expect(status.loadVerdict).toBe('unknown');
    expect(status.policy).toBeNull();
  });

  // .bashrc has no signing gate, so there is nothing to ask and no reason to
  // pay for a process spawn.
  it('never probes for bash, whatever the platform', () => {
    installShell('bash');
    const { probe, count } = countingProbe('Restricted');
    const status = shellStatus('bash', probe);

    expect(status.loadVerdict).toBe('ok');
    expect(status.policy).toBeNull();
    expect(count()).toBe(0);
  });

  // PowerShell 7 keeps its execution policy separately from 5.1, so asking the
  // wrong binary can give a confidently wrong answer about whether a profile
  // will load.
  it('asks each PowerShell about its own policy', () => {
    const asked: string[] = [];
    const probe: PolicyProbe = {
      platform: 'win32',
      env: {},
      run: (command) => {
        asked.push(command);
        return 'RemoteSigned';
      },
    };
    shellStatus('powershell', probe);
    shellStatus('pwsh', probe);
    expect(asked).toEqual(['powershell.exe', 'pwsh.exe']);
  });

  // PowerShell 7 is cross-platform and follows XDG outside Windows. Reusing the
  // Windows path would recreate the very bug this split fixes, one axis over: a
  // Mac user with pwsh gets "created" and a file pwsh never opens.
  it('puts the PowerShell 7 profile where that platform actually looks', () => {
    delete process.env['FAMILIAR_PROFILE_PWSH'];

    const windows = profilePathFor('pwsh', 'win32');
    expect(windows).toContain('Documents');
    expect(windows).toContain('PowerShell');

    for (const platform of ['darwin', 'linux'] as NodeJS.Platform[]) {
      const path = profilePathFor('pwsh', platform);
      expect(path, platform).toContain('.config');
      expect(path, platform).toContain('powershell');
      expect(path, platform).not.toContain('Documents');
    }
  });

  // Documents\WindowsPowerShell is as fictional on a Mac as a PS7 profile is on
  // a box without pwsh, and the gate exists to stop inventing either.
  it('does not claim Windows PowerShell exists off Windows', () => {
    const anywhere = { pathDirs: [], exists: () => false };
    expect(shellPresent('powershell', { ...anywhere, platform: 'win32' })).toBe(true);
    for (const platform of ['darwin', 'linux'] as NodeJS.Platform[]) {
      expect(shellPresent('powershell', { ...anywhere, platform }), platform).toBe(false);
    }
    // Dotfiles stay unconditional: cheap, conventional, and cross-platform.
    for (const platform of ['darwin', 'linux', 'win32'] as NodeJS.Platform[]) {
      expect(shellPresent('bash', { ...anywhere, platform }), platform).toBe(true);
      expect(shellPresent('zsh', { ...anywhere, platform }), platform).toBe(true);
    }
  });

  it('gates PowerShell 7 on it actually being installed', () => {
    const absent = { pathDirs: ['/usr/bin'], exists: () => false, platform: 'linux' as const };
    const present = {
      pathDirs: ['/usr/bin'],
      exists: (p: string) => p.endsWith('pwsh'),
      platform: 'linux' as const,
    };
    // No pwsh binary anywhere: a bulk install must not invent a PS7 profile.
    expect(shellPresent('pwsh', absent)).toBe(false);
    expect(shellPresent('pwsh', present)).toBe(true);
    // Dotfiles stay unconditional. `powershell` deliberately does not: the
    // probe above is on linux, where a Windows PowerShell profile is fiction.
    for (const shell of ['bash', 'zsh'] as const) {
      expect(shellPresent(shell, absent), shell).toBe(true);
    }
    expect(shellPresent('powershell', absent)).toBe(false);
  });

  it('never probes off Windows', () => {
    installShell('powershell');
    const { probe, count } = countingProbe('Restricted', 'linux');
    expect(shellStatus('powershell', probe).loadVerdict).toBe('ok');
    expect(count()).toBe(0);
  });

  it('asks at most once per call — the probe is a process spawn', () => {
    installShell('powershell');
    const { probe, count } = countingProbe('Restricted');
    shellStatus('powershell', probe);
    expect(count()).toBe(1);
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

  // zsh is not bash with a different filename. It has real hooks, so none of
  // bash's history parsing should have been copied across.
  it('zsh takes the command from preexec rather than parsing history', () => {
    const snippet = snippetFor('zsh');
    expect(snippet).toContain('__familiar_preexec');
    expect(snippet).toContain('__FAMILIAR_CMD="$1"');
    expect(snippet).not.toContain('HISTTIMEFORMAT');
    expect(snippet).not.toContain('history 1');
  });

  // add-zsh-hook is deliberately not used: `autoload` installs a stub whether
  // or not the definition file exists, so any "is it available?" check passes
  // unconditionally and the fallback it guards is unreachable. Appending to the
  // arrays is what add-zsh-hook does anyway, and it cannot fail.
  it('zsh registers its hooks without depending on add-zsh-hook', () => {
    const snippet = snippetFor('zsh');
    expect(snippet).toContain('preexec_functions+=(__familiar_preexec)');
    expect(snippet).toContain('precmd_functions+=(__familiar_precmd)');
    expect(snippet).toContain('typeset -ga preexec_functions precmd_functions');
    // The comment above the registration explains why add-zsh-hook is avoided,
    // so match on it being *called* rather than merely mentioned.
    expect(snippet).not.toMatch(/^\s*add-zsh-hook\s/m);
    expect(snippet).not.toContain('autoload -Uz add-zsh-hook');
  });

  it('zsh guards against re-sourcing so hooks cannot double up', () => {
    expect(snippetFor('zsh')).toContain('__FAMILIAR_ZSH_INSTALLED');
  });

  it('zsh loads the module its millisecond timestamps depend on', () => {
    // Without zsh/datetime there is no EPOCHREALTIME, and two identical
    // commands in the same second would dedupe into one event.
    expect(snippetFor('zsh')).toContain('zmodload zsh/datetime');
  });

  it('zsh returns the exit code it captured', () => {
    const snippet = snippetFor('zsh');
    expect(snippet).toContain('local __code=$?');
    expect(snippet).toContain('return $__code');
  });

  it('does not use PROMPT_COMMAND for zsh, which has no such thing', () => {
    expect(snippetFor('zsh')).not.toContain('PROMPT_COMMAND');
  });

  // The two PowerShells share a snippet but not a profile, and neither reads
  // the other's. Writing only the 5.1 path left PS7 users with a success
  // message and a file their shell never opens.
  it('gives the two PowerShells the same snippet but different profiles', () => {
    expect(snippetFor('pwsh')).toBe(snippetFor('powershell'));
    delete process.env['FAMILIAR_PROFILE_PWSH'];
    delete process.env['FAMILIAR_PROFILE_POWERSHELL'];
    expect(profilePathFor('pwsh')).not.toBe(profilePathFor('powershell'));
    expect(profilePathFor('powershell')).toContain('WindowsPowerShell');
    expect(profilePathFor('pwsh')).toContain('PowerShell');
    expect(profilePathFor('pwsh')).not.toContain('WindowsPowerShell');
  });

  it('gives each shell its own conventional profile path', () => {
    expect(profilePathFor('zsh')).toBe(join(profileDir, '.zshrc'));
    delete process.env['FAMILIAR_PROFILE_ZSH'];
    expect(profilePathFor('zsh').endsWith('.zshrc')).toBe(true);
    expect(profilePathFor('zsh')).not.toBe(profilePathFor('bash'));
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

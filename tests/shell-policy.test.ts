import { describe, expect, it } from 'vitest';

import {
  classifyPolicy,
  persistentExecutionPolicy,
  POLICY_FIX_COMMAND,
  profileLoadVerdict,
  PROCESS_POLICY_VAR,
  withoutProcessPolicy,
  type PolicyProbe,
} from '../src/shell/policy.js';

interface Recorded {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** A probe that answers with a fixed string and records what it was asked. */
function fakeProbe(
  output: string | null,
  platform: NodeJS.Platform = 'win32',
  env: NodeJS.ProcessEnv = {},
): { probe: PolicyProbe; calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    probe: {
      platform,
      env,
      run: (command, args, childEnv) => {
        calls.push({ command, args, env: childEnv });
        return output;
      },
    },
  };
}

describe('classifyPolicy', () => {
  it('treats the policies that refuse unsigned scripts as blocking', () => {
    for (const name of ['Restricted', 'AllSigned']) {
      expect(classifyPolicy(name), name).toBe('blocked');
    }
  });

  it('treats the policies that will run a local profile as fine', () => {
    for (const name of ['RemoteSigned', 'Unrestricted', 'Bypass']) {
      expect(classifyPolicy(name), name).toBe('ok');
    }
  });

  it('does not care about case or stray whitespace', () => {
    expect(classifyPolicy('  restricted\r\n')).toBe('blocked');
    expect(classifyPolicy('REMOTESIGNED')).toBe('ok');
  });

  // Guessing either way is worse than admitting ignorance: a false 'blocked'
  // nags people who are fine, a false 'ok' hides the bug this exists to catch.
  it('refuses to guess at anything it does not recognise', () => {
    for (const name of [null, undefined, '', '   ', 'Undefined', 'banana']) {
      expect(classifyPolicy(name), String(name)).toBe('unknown');
    }
  });
});

describe('withoutProcessPolicy', () => {
  it('removes the inherited process-scope override and nothing else', () => {
    const source = { [PROCESS_POLICY_VAR]: 'Bypass', PATH: '/usr/bin', HOME: '/home/x' };
    const stripped = withoutProcessPolicy(source);
    expect(PROCESS_POLICY_VAR in stripped).toBe(false);
    expect(stripped['PATH']).toBe('/usr/bin');
    expect(stripped['HOME']).toBe('/home/x');
  });

  it('does not mutate the environment it was given', () => {
    const source = { [PROCESS_POLICY_VAR]: 'Bypass' };
    withoutProcessPolicy(source);
    expect(source[PROCESS_POLICY_VAR]).toBe('Bypass');
  });

  it('copes with the variable already being absent', () => {
    expect(() => withoutProcessPolicy({})).not.toThrow();
  });
});

describe('persistentExecutionPolicy', () => {
  // THE regression guard. Process scope outranks CurrentUser and LocalMachine,
  // is inherited by children, and agent harnesses set it to Bypass. Ask the
  // naive question and a blocked machine reports itself healthy — which is
  // exactly how this bug stayed invisible while it was being investigated.
  it('asks with the inherited process-scope override stripped out', () => {
    const { probe, calls } = fakeProbe('Restricted', 'win32', {
      [PROCESS_POLICY_VAR]: 'Bypass',
      PATH: 'C:\\Windows',
    });

    expect(persistentExecutionPolicy(probe)).toBe('Restricted');
    expect(calls).toHaveLength(1);
    expect(PROCESS_POLICY_VAR in calls[0]!.env).toBe(false);
    expect(calls[0]!.env['PATH']).toBe('C:\\Windows');
  });

  // Without this the probe would trip the very error it is diagnosing.
  it('always asks with -NoProfile', () => {
    const { probe, calls } = fakeProbe('RemoteSigned');
    persistentExecutionPolicy(probe);
    expect(calls[0]!.args).toContain('-NoProfile');
    expect(calls[0]!.args).toContain('-NonInteractive');
    expect(calls[0]!.args).toContain('Get-ExecutionPolicy');
    expect(calls[0]!.command).toBe('powershell.exe');
  });

  it('trims the newline PowerShell leaves on its output', () => {
    expect(persistentExecutionPolicy(fakeProbe('RemoteSigned\r\n').probe)).toBe('RemoteSigned');
  });

  it('reports nothing rather than guessing when the probe fails', () => {
    expect(persistentExecutionPolicy(fakeProbe(null).probe)).toBeNull();
    expect(persistentExecutionPolicy(fakeProbe('   ').probe)).toBeNull();
  });

  it('never spawns anything off Windows', () => {
    const { probe, calls } = fakeProbe('Restricted', 'linux');
    expect(persistentExecutionPolicy(probe)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('profileLoadVerdict', () => {
  it('reports a blocked machine as blocked', () => {
    expect(profileLoadVerdict(fakeProbe('Restricted').probe)).toBe('blocked');
    expect(profileLoadVerdict(fakeProbe('AllSigned').probe)).toBe('blocked');
  });

  it('reports a permissive machine as fine', () => {
    expect(profileLoadVerdict(fakeProbe('RemoteSigned').probe)).toBe('ok');
  });

  it('is fine everywhere that has no signing gate at all', () => {
    for (const platform of ['linux', 'darwin', 'freebsd'] as NodeJS.Platform[]) {
      const { probe, calls } = fakeProbe(null, platform);
      expect(profileLoadVerdict(probe), platform).toBe('ok');
      expect(calls).toHaveLength(0);
    }
  });

  it('is unknown, not a failure, when the probe cannot answer', () => {
    expect(profileLoadVerdict(fakeProbe(null).probe)).toBe('unknown');
  });

  // `familiar shell status` does not wrap its body, so a throwing probe would
  // take the whole command down over a cosmetic diagnostic.
  it('does not propagate a probe that throws', () => {
    const probe: PolicyProbe = {
      platform: 'win32',
      env: {},
      run: () => {
        throw new Error('powershell is not installed');
      },
    };
    expect(() => profileLoadVerdict(probe)).not.toThrow();
    expect(profileLoadVerdict(probe)).toBe('unknown');
  });
});

describe('the advice we print', () => {
  it('names the scope, so it needs no admin rights', () => {
    expect(POLICY_FIX_COMMAND).toContain('-Scope CurrentUser');
    expect(POLICY_FIX_COMMAND).toContain('RemoteSigned');
  });
});

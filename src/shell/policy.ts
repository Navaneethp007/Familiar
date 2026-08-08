/**
 * Whether Windows will actually let a PowerShell profile load.
 *
 * `familiar shell install` writes a profile. On Windows that file is only ever
 * read if the execution policy permits it — and the stock client default,
 * `Restricted`, does not. So the install can succeed completely and still leave
 * the user with a security error on every shell launch and no integration at
 * all. This module is how the CLI notices.
 *
 * Nothing here runs in a hook or the statusline. It is reached only from
 * `familiar shell install` and `familiar shell status`, where one short-lived
 * subprocess is affordable.
 */

import { execFileSync } from 'node:child_process';

export type PolicyVerdict = 'ok' | 'blocked' | 'unknown';

/** Policies that refuse to run an unsigned local script. Compared lower-cased. */
export const BLOCKING_POLICIES: readonly string[] = ['restricted', 'allsigned'];

/** Policies that will happily run a profile we wrote. */
export const PERMISSIVE_POLICIES: readonly string[] = ['remotesigned', 'unrestricted', 'bypass'];

/**
 * The environment variable PowerShell reads its *process-scope* policy from.
 *
 * This is the crux of the whole module. Process scope outranks both CurrentUser
 * and LocalMachine, the variable is inherited by child processes, and agent
 * harnesses routinely set it to Bypass. Ask a child process the naive question
 * and it will happily answer "Bypass, all fine" while the user's own shell is
 * still refusing to load the profile.
 */
export const PROCESS_POLICY_VAR = 'PSExecutionPolicyPreference';

/**
 * Maps a policy name to a verdict.
 *
 * Anything unrecognised — including an empty string and `Undefined` — is
 * `unknown` rather than a guess in either direction. Claiming `blocked` would
 * nag people who are fine; claiming `ok` would hide the bug this exists to
 * catch.
 */
export function classifyPolicy(name: string | null | undefined): PolicyVerdict {
  const normalised = (name ?? '').trim().toLowerCase();
  if (normalised.length === 0) return 'unknown';
  if (BLOCKING_POLICIES.includes(normalised)) return 'blocked';
  if (PERMISSIVE_POLICIES.includes(normalised)) return 'ok';
  return 'unknown';
}

/** Strips the inherited process-scope override so the persistent policy shows through. */
export function withoutProcessPolicy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy[PROCESS_POLICY_VAR];
  return copy;
}

export interface PolicyProbe {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Returns stdout, or null for any failure at all. */
  run: (command: string, args: string[], env: NodeJS.ProcessEnv) => string | null;
}

const PROBE_TIMEOUT_MS = 5_000;

export function realPolicyProbe(): PolicyProbe {
  return {
    platform: process.platform,
    env: process.env,
    // Mirrors the hardened git() helper: args as an array, a timeout, no window,
    // stderr discarded, and every failure flattened to null. "PowerShell is
    // missing", "it hung" and "it errored" all mean the same thing here — we
    // could not find out.
    run: (command, args, env) => {
      try {
        return execFileSync(command, args, {
          env,
          encoding: 'utf8',
          timeout: PROBE_TIMEOUT_MS,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        return null;
      }
    },
  };
}

/**
 * The policy a normal, freshly-opened shell would see.
 *
 * `-NoProfile` is load-bearing rather than hygiene: without it the probe would
 * trip the very error it is trying to detect, and we would be reading the exit
 * status of our own diagnosis.
 */
export function persistentExecutionPolicy(
  probe: PolicyProbe,
  command = 'powershell.exe',
): string | null {
  if (probe.platform !== 'win32') return null;

  // `realPolicyProbe` already swallows everything, but this is reached from
  // `familiar shell status`, which does not wrap its body — so a probe that
  // throws would take the whole command down over a cosmetic diagnostic.
  let output: string | null;
  try {
    // Asked of the *same* binary the profile belongs to. Windows PowerShell and
    // PowerShell 7 keep their policies in different places, so probing 5.1 to
    // decide whether a 7 profile will load can give a confidently wrong answer.
    output = probe.run(
      command,
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-ExecutionPolicy'],
      withoutProcessPolicy(probe.env),
    );
  } catch {
    return null;
  }

  const value = (output ?? '').trim();
  return value.length > 0 ? value : null;
}

/** `ok` everywhere but Windows — no other platform has a signing gate on rc files. */
export function profileLoadVerdict(probe: PolicyProbe, command?: string): PolicyVerdict {
  if (probe.platform !== 'win32') return 'ok';
  return classifyPolicy(persistentExecutionPolicy(probe, command));
}

/** The one-line fix, kept next to the detection so the two cannot drift. */
export const POLICY_FIX_COMMAND = 'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned';

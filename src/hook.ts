/**
 * The hook entrypoint, invoked by Claude Code as `node cli.js hook --event=X`.
 *
 * ── THE RULE THAT MATTERS MOST ───────────────────────────────────────────────
 * This process ALWAYS exits 0.
 *
 * Claude Code reads exit code 2 from a `Stop` hook as "do not stop" and from
 * `PreToolUse` as "block this tool". A crash here would not degrade Familiar —
 * it would break the user's editing session. A toy that does that is
 * uninstalled within the hour and never reinstalled.
 *
 * So: every failure is caught, written to ~/.familiar/error.log, and swallowed.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { eventsFromHook, type HookPayload } from './adapters/claude-code.js';
import { scanAll } from './adapters/git.js';
import { drainShellLog } from './adapters/terminal.js';
import type { FamiliarEvent } from './core/events.js';
import { deriveState, type CreatureState } from './core/xp.js';
import { isNightHour } from './core/habits.js';
import { shouldSpeak, speak, type SpeakKey } from './core/tone.js';
import {
  logError,
  readOrCreateConfig,
  readRenderCache,
  writeRenderCache,
} from './state/config.js';
import { appendEvents, readEvents } from './state/log.js';

/** Events after which a git scan is worthwhile. */
const SCAN_ON = new Set(['SessionStart', 'Stop', 'SessionEnd', 'StopFailure']);

export function readStdin(timeoutMs = 2_000): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }

    let data = '';
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve(data);
    };

    // A hook that hangs waiting on stdin would stall the session, so cap it.
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

/**
 * Picks the one thing worth saying about a batch of new events, most
 * significant first. Returns null when nothing rises to the level of speech —
 * silence is the default, because a familiar that comments on everything gets
 * muted.
 */
export function chooseSpeakKey(
  before: CreatureState,
  after: CreatureState,
  fresh: readonly FamiliarEvent[],
): { key: SpeakKey; seed: string } | null {
  if (after.branch !== null && before.branch === null) {
    return { key: 'evolved', seed: after.evolvedOn?.key ?? 'evolved' };
  }
  if (after.level > before.level) {
    return { key: 'level_up', seed: `${after.level}` };
  }

  // A fix outranks everything except evolving and levelling. It is the only
  // moment the familiar can say something the log alone knows — that this was
  // broken, and now it isn't.
  if (after.checks.fixes > before.checks.fixes) {
    const fix = after.checks.lastFix;
    if (fix) {
      const key: SpeakKey =
        fix.agent !== null ? 'fixed_together' : fix.attempts >= 3 ? 'check_fixed_hard' : 'check_fixed';
      return { key, seed: fix.eventKey };
    }
  }

  const priority: SpeakKey[] = ['pr_merged', 'pr_opened'];
  for (const key of priority) {
    const match = fresh.find((e) => e.type === key);
    if (match) return { key, seed: match.key };
  }

  const broke = fresh.find((e) => e.type === 'check_failed' || e.type === 'tests_failed');
  if (broke) return { key: 'check_broke', seed: broke.key };

  const commit = [...fresh].reverse().find((e) => e.type === 'commit');
  if (commit) {
    const hour = commit.meta.hour;
    const night = typeof hour === 'number' && isNightHour(hour);
    return { key: night ? 'night_commit' : 'commit', seed: commit.key };
  }

  return null;
}

async function run(event: string): Promise<void> {
  const config = readOrCreateConfig();

  const raw = await readStdin();
  let payload: HookPayload = { hook_event_name: event };
  if (raw.trim().length > 0) {
    try {
      // Strip a UTF-8 BOM. Claude Code does not send one, but anything that
      // pipes a payload in on Windows might, and losing the whole payload to
      // an invisible byte is a miserable way to fail.
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      payload = { ...(JSON.parse(text) as HookPayload) };
    } catch (error) {
      logError('hook:parse-stdin', error);
    }
  }
  // Trust the flag over the payload: the flag is what we wired up ourselves.
  payload.hook_event_name = event || payload.hook_event_name;

  const before = deriveState(readEvents(), { species: config.species });

  const incoming: FamiliarEvent[] = [...eventsFromHook(payload)];

  // Always drain the shell spool — it is cheap, and a hook firing is the most
  // frequent opportunity to pick up what you ran in your own terminal.
  try {
    incoming.push(...drainShellLog());
  } catch (error) {
    logError('hook:drain-shell', error);
  }

  if (SCAN_ON.has(event)) {
    try {
      incoming.push(...scanAll(payload.cwd ?? process.cwd()));
    } catch (error) {
      logError('hook:git-scan', error);
    }
  }

  const fresh = appendEvents(incoming);
  if (fresh.length === 0) return;

  const after = deriveState(readEvents(), { species: config.species });

  const choice = chooseSpeakKey(before, after, fresh);
  if (!choice) return;

  // Big moments bypass the cooldown — an evolution should never be swallowed
  // because a commit happened to land a minute earlier.
  const alwaysSpeak = choice.key === 'evolved' || choice.key === 'level_up';
  if (!alwaysSpeak && !shouldSpeak(readRenderCache()?.updatedAt)) return;

  writeRenderCache(speak(config.tone, choice.key, choice.seed));
}

export async function runHook(event: string): Promise<void> {
  try {
    await run(event);
  } catch (error) {
    logError(`hook:${event}`, error);
  } finally {
    // Belt and braces. Nothing below this line may change the exit code.
    process.exitCode = 0;
  }
}

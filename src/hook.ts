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
import { speakAloud, VOICE_KEYS } from './adapters/voice.js';
import { drainShellLog } from './adapters/terminal.js';
import type { FamiliarEvent } from './core/events.js';
import { deriveState, MAX_LEVEL, type CreatureState } from './core/xp.js';
import { highestMilestone, milestoneSpeakKey } from './core/milestones.js';
import { isNightHour } from './core/habits.js';
import { shouldSpeak, speak, type SpeakKey } from './core/tone.js';
import {
  logError,
  readOrCreateConfig,
  readRenderCache,
  writeRenderCache,
} from './state/config.js';
import { appendEvents, readEvents } from './state/log.js';
import { evolutionFor, rememberEvolution } from './state/identity.js';

/**
 * How long a hook may keep starting new repos in a git scan.
 *
 * Claude Code kills a hook at 10 s (install.ts). Up to 2 s of that can go on
 * reading stdin, one repo already under way can take up to GIT_TIMEOUT_MS, and
 * the two folds and startup need the rest. Repos not reached are scanned first
 * next time, and a scan killed anyway keeps every repo it finished.
 */
const HOOK_SCAN_BUDGET_MS = 3_000;

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
/**
 * Keys that skip the 90-second text cooldown.
 *
 * Safe because none of them can repeat *within a process*. A level is crossed
 * once, a branch locks once, the cap is reached once — and a milestone fires on
 * `before < T && after >= T`, over counts that are monotone because the log is
 * append-only and deduped, so each (track, threshold) pair is observed at most
 * once by any one hook run.
 *
 * Across processes it is weaker than that: `before` and `after` are two reads
 * around an append, so two concurrent sessions can both observe the same
 * crossing and both announce it. Rare, harmless, and the honest bound is "once
 * per process", not "once ever" — the cure would be persisting what has been
 * said, which is the kind of state this project derives instead.
 */
const ALWAYS_SPEAK: ReadonlySet<SpeakKey> = new Set<SpeakKey>([
  'evolved',
  'level_up',
  'max_level',
  'milestone_commits',
  'milestone_merges',
  'milestone_fixes',
]);

export function chooseSpeakKey(
  before: CreatureState,
  after: CreatureState,
  fresh: readonly FamiliarEvent[],
): { key: SpeakKey; seed: string } | null {
  if (after.branch !== null && before.branch === null) {
    return { key: 'evolved', seed: after.evolvedOn?.key ?? 'evolved' };
  }

  // The end of the ladder, said once. Detectable from the two folds alone —
  // the transition can only ever be observed at the moment it happens, so
  // nothing needs to remember that it did. Above level_up because it IS the
  // level up, and the bigger fact about it.
  if (before.level < MAX_LEVEL && after.level >= MAX_LEVEL) {
    return { key: 'max_level', seed: `${MAX_LEVEL}` };
  }

  if (after.level > before.level) {
    return { key: 'level_up', seed: `${after.level}` };
  }

  // Landmarks outrank the fix keys because they are roughly twenty times
  // rarer: a real 85-day log held 113 fixes and 186 merges but only about
  // eight milestone crossings, and log spacing means that ratio can never
  // invert. Below level_up because the XP bar is the framing everything else
  // hangs off.
  //
  // Only one key can be returned and there is no queue, so a batch that both
  // levels up and crosses a landmark drops the landmark. That is accepted: the
  // co-occurrence is coincidental, and a queue would need to survive the
  // process, which means persisting state that is supposed to be derived.
  const milestone = highestMilestone(before, after);
  if (milestone) {
    return { key: milestoneSpeakKey(milestone.track), seed: milestone.id };
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

  const merged = fresh.find((e) => e.type === 'pr_merged');
  if (merged) return { key: 'pr_merged', seed: merged.key };

  const broke = fresh.find((e) => e.type === 'check_failed' || e.type === 'tests_failed');
  if (broke) return { key: 'check_broke', seed: broke.key };

  // Below check_broke deliberately: something newly working is good news, but
  // something newly broken is the news you need first. Read off the whole-log
  // fold rather than `fresh`, because "first ever" is not a property of a batch.
  if (after.checks.coldFirstGreens > before.checks.coldFirstGreens) {
    const green = after.checks.lastColdGreen;
    if (green) return { key: 'tests_passed', seed: green.eventKey };
  }

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

  // Settle the evolution once, up front, and use the same lock on both sides.
  // A lock that differed between the folds would read as an evolution that
  // never happened — or hide one that just did.
  const existing = readEvents();
  const evolution = evolutionFor(config, existing);
  const before = deriveState(existing, { species: config.species, evolution });
  rememberEvolution(existing, before);

  const incoming: FamiliarEvent[] = [...eventsFromHook(payload)];

  // Always drain the shell spool — it is cheap, and a hook firing is the most
  // frequent opportunity to pick up what you ran in your own terminal.
  try {
    incoming.push(...drainShellLog());
  } catch (error) {
    logError('hook:drain-shell', error);
  }

  const fresh = appendEvents(incoming);

  // After the hook's own events are safely written: the scan is the slow part,
  // and it writes its own findings repo by repo, so being killed mid-scan
  // costs neither these events nor the repos it already finished.
  if (SCAN_ON.has(event)) {
    try {
      fresh.push(...scanAll(payload.cwd ?? process.cwd(), { budgetMs: HOOK_SCAN_BUDGET_MS }));
    } catch (error) {
      logError('hook:git-scan', error);
    }
  }

  if (fresh.length === 0) return;

  const everything = readEvents();
  const after = deriveState(everything, { species: config.species, evolution });
  if (after.branch !== before.branch) rememberEvolution(everything, after);

  const choice = chooseSpeakKey(before, after, fresh);
  if (!choice) return;

  // Big moments bypass the cooldown — an evolution should never be swallowed
  // because a commit happened to land a minute earlier.
  if (!ALWAYS_SPEAK.has(choice.key) && !shouldSpeak(readRenderCache()?.updatedAt)) return;

  const quip = speak(config.tone, choice.key, choice.seed);
  writeRenderCache(quip);

  // After the cache write, so the line still lands even if audio misbehaves.
  // speakAloud spawns detached and owns its own failures, so nothing below this
  // point can delay or fail the hook.
  //
  // No separate voice cooldown: the two fix keys are rate-limited by the check
  // above, and everything in ALWAYS_SPEAK reaches here with no limit at all —
  // which is fine only because none of those can repeat. See the note there.
  if (config.voice && VOICE_KEYS.has(choice.key)) speakAloud(quip);
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

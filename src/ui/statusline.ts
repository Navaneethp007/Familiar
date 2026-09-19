/**
 * The statusline: a single passive line in Claude Code's footer.
 *
 * **This code is strictly read-only.** Claude Code re-runs the statusline on
 * every assistant message, debounces at 300ms, and cancels the in-flight script
 * when a new update arrives. A script that can be killed at any moment must
 * never be the thing writing your event log. Hooks write; this only reads.
 *
 * It also has to be fast, so it does the cheap thing: fold the log (a few ms
 * even at thousands of events) and read a pre-chosen quip from a small cache.
 */

import { formIdentity } from '../core/forms.js';
import { deriveState, IDLE_AFTER_MS, type EvolutionRecord } from '../core/xp.js';
import type { FamiliarEvent } from '../core/events.js';
import type { Species } from '../core/species.js';
import { ambientCycle, speak, speakCycle, type ToneName } from '../core/tone.js';
import { readRenderCache } from '../state/config.js';

/** How long a quip stays on screen before the line goes quiet again. */
export const QUIP_TTL_MS = 5 * 60 * 1000;

export function miniBar(progress: number, width = 5): string {
  // See the note in status-card.ts: NaN must not collapse the bar to nothing.
  const safe = Number.isFinite(progress) ? progress : 0;
  const on = Math.round(Math.min(1, Math.max(0, safe)) * width);
  return '▓'.repeat(on) + '░'.repeat(Math.max(0, width - on));
}

/**
 * What sits where the bar used to, once there is no next level.
 *
 * A progress bar pinned full is indistinguishable from one that rounded up, so
 * at the cap it reads as a bug rather than an achievement — the number stops
 * moving, the bar stops moving, and nothing says why. This is the same five
 * cells wide, so the line's geometry never changes, but it is unmistakably not
 * a gauge. It steps on the same cycle as the ambient line so the whole footer
 * moves as one creature rather than two widgets.
 */
const PEAK_FRAMES = ['✦····', '·✦···', '··✦··', '···✦·', '····✦', '···✦·', '··✦··', '·✦···'] as const;

export function peakMark(cycle: number): string {
  const n = PEAK_FRAMES.length;
  const safe = Number.isFinite(cycle) ? Math.trunc(cycle) : 0;
  return PEAK_FRAMES[((safe % n) + n) % n] ?? PEAK_FRAMES[0];
}

export interface StatuslineInput {
  events: readonly FamiliarEvent[];
  species: Species;
  /** Needed for the idle line. Optional so existing callers keep working. */
  tone?: ToneName;
  quip?: string | null;
  now?: Date;
  /** An evolution already earned. See state/identity.ts. */
  evolution?: EvolutionRecord | null;
  /** A second evolution, if one has happened. Replaces the first outright. */
  reevolution?: EvolutionRecord | null;
}

/**
 * How long the log has been silent, in ms.
 *
 * An empty log is the idlest state there is — a fresh install has nothing else
 * to say, and "ready when you are" reads far better than a bare empty bar. An
 * unparseable timestamp is treated the same way rather than throwing.
 */
function quietFor(lastEventAt: string | null, now: number): number {
  if (lastEventAt === null) return Number.POSITIVE_INFINITY;
  const at = Date.parse(lastEventAt);
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : now - at;
}

export function renderStatusline(input: StatuslineInput): string {
  const now = input.now ?? new Date();
  const state = deriveState(input.events, {
    species: input.species,
    now,
    evolution: input.evolution ?? null,
    reevolution: input.reevolution ?? null,
  });
  const form = formIdentity(state.species, state.stage, state.branch);
  const tone = input.tone ?? 'deadpan';

  // `nextLevelAt === null` is the cap — the same idiom the status card uses, so
  // the two surfaces cannot disagree about what "maxed" means.
  const capped = state.nextLevelAt === null;
  const cycle = ambientCycle(now);
  const gauge = capped ? peakMark(cycle) : miniBar(state.progress);

  const base = `${form.emoji} Lv.${state.level} ${gauge}`;
  if (input.quip) return `${base} · "${input.quip}"`;

  // Nothing fresh to say, and nothing has happened in days. Say so — but pick
  // deterministically. This function re-runs many times a minute, so a random
  // choice would flicker on every keystroke. The local calendar date is stable
  // within a day and moves on tomorrow, and costs no I/O to compute, which
  // matters because this file is not allowed to write anything.
  if (quietFor(state.lastEventAt, now.getTime()) > IDLE_AFTER_MS) {
    const dayStamp = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
    return `${base} · "${speak(tone, 'idle', dayStamp)}"`;
  }

  // Past the cap there is no bar left to watch, so the voice is the whole
  // surface — this line never falls through to a bare one. It sits below the
  // idle check on purpose: after three silent days "waiting." is the truer
  // thing to say, and IDLE_AFTER_MS is the older contract.
  if (capped) return `${base} · "${speakCycle(tone, 'at_peace', cycle)}"`;

  return base;
}

/** Reads the cached quip, if one was set recently enough to still be worth showing. */
export function freshQuip(now = new Date()): string | null {
  const cache = readRenderCache();
  if (!cache?.quip) return null;
  const at = Date.parse(cache.updatedAt);
  if (Number.isNaN(at) || now.getTime() - at > QUIP_TTL_MS) return null;
  return cache.quip;
}

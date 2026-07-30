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
import { deriveState } from '../core/xp.js';
import type { FamiliarEvent } from '../core/events.js';
import type { Species } from '../core/species.js';
import { readRenderCache } from '../state/config.js';

/** How long a quip stays on screen before the line goes quiet again. */
export const QUIP_TTL_MS = 5 * 60 * 1000;

export function miniBar(progress: number, width = 5): string {
  // See the note in status-card.ts: NaN must not collapse the bar to nothing.
  const safe = Number.isFinite(progress) ? progress : 0;
  const on = Math.round(Math.min(1, Math.max(0, safe)) * width);
  return '▓'.repeat(on) + '░'.repeat(Math.max(0, width - on));
}

export interface StatuslineInput {
  events: readonly FamiliarEvent[];
  species: Species;
  quip?: string | null;
  now?: Date;
}

export function renderStatusline(input: StatuslineInput): string {
  const now = input.now ?? new Date();
  const state = deriveState(input.events, { species: input.species, now });
  const form = formIdentity(state.species, state.stage, state.branch);

  const base = `${form.emoji} Lv.${state.level} ${miniBar(state.progress)}`;
  return input.quip ? `${base} · "${input.quip}"` : base;
}

/** Reads the cached quip, if one was set recently enough to still be worth showing. */
export function freshQuip(now = new Date()): string | null {
  const cache = readRenderCache();
  if (!cache?.quip) return null;
  const at = Date.parse(cache.updatedAt);
  if (Number.isNaN(at) || now.getTime() - at > QUIP_TTL_MS) return null;
  return cache.quip;
}

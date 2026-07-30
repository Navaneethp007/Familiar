/**
 * The event log: append-only JSONL at ~/.familiar/events.jsonl.
 *
 * Two properties matter more than anything else here.
 *
 * 1. Writes are single-line appends. Several hooks can fire at once, and an
 *    O_APPEND write of a sub-sector-sized line is effectively atomic, so
 *    concurrent writers do not interleave in practice.
 * 2. Reads never throw. A torn final line from a process killed mid-write, a
 *    hand-edited file, a stray blank line — all are skipped. This file is read
 *    from inside a Claude Code hook, and a parse error there would surface as a
 *    broken session.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { dedupeEvents, isFamiliarEvent, sortEvents, type FamiliarEvent } from '../core/events.js';
import { eventsPath, familiarHome } from './paths.js';

export function ensureHome(): string {
  const home = familiarHome();
  mkdirSync(home, { recursive: true });
  return home;
}

export interface ReadResult {
  events: FamiliarEvent[];
  /** Lines that could not be parsed. Surfaced by `familiar status --debug`. */
  skipped: number;
}

export function readEventsDetailed(path = eventsPath()): ReadResult {
  if (!existsSync(path)) return { events: [], skipped: 0 };

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { events: [], skipped: 0 };
  }

  // Strip a UTF-8 BOM if some editor added one.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  const events: FamiliarEvent[] = [];
  let skipped = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isFamiliarEvent(parsed)) {
        events.push(parsed);
      } else {
        skipped++;
      }
    } catch {
      // Garbage, or the last line of a file that was cut short mid-write.
      skipped++;
    }
  }

  return { events: dedupeEvents(sortEvents(events)), skipped };
}

export function readEvents(path = eventsPath()): FamiliarEvent[] {
  return readEventsDetailed(path).events;
}

/** Appends events, dropping any whose key is already on disk. Returns what was written. */
export function appendEvents(
  incoming: readonly FamiliarEvent[],
  path = eventsPath(),
): FamiliarEvent[] {
  if (incoming.length === 0) return [];

  const existing = readEvents(path);
  const seen = new Set(existing.map((e) => e.key));

  const fresh: FamiliarEvent[] = [];
  for (const event of incoming) {
    if (seen.has(event.key)) continue;
    seen.add(event.key);
    fresh.push(event);
  }
  if (fresh.length === 0) return [];

  mkdirSync(dirname(path), { recursive: true });
  const payload = fresh.map((e) => JSON.stringify(e)).join('\n') + '\n';
  appendFileSync(path, payload, { encoding: 'utf8' });

  return fresh;
}

export function appendEvent(event: FamiliarEvent, path = eventsPath()): boolean {
  return appendEvents([event], path).length > 0;
}

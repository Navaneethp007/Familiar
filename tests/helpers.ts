import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeEvent, type EventType, type FamiliarEvent } from '../src/core/events.js';

/** A disposable ~/.familiar for a test. */
export function useTempHome(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-test-'));
  const previous = process.env['FAMILIAR_HOME'];
  process.env['FAMILIAR_HOME'] = dir;
  return {
    dir,
    cleanup: () => {
      if (previous === undefined) delete process.env['FAMILIAR_HOME'];
      else process.env['FAMILIAR_HOME'] = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function tempDir(prefix = 'familiar-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

let counter = 0;

/** A minimal event with a unique key, for XP arithmetic. */
export function ev(type: EventType, overrides: Partial<FamiliarEvent> = {}): FamiliarEvent {
  counter++;
  return makeEvent({
    type,
    source: 'manual',
    key: overrides.key ?? `${type}:${counter}`,
    at: overrides.t ?? new Date('2026-07-01T12:00:00Z'),
    meta: overrides.meta ?? {},
  });
}

/** `n` events of one type, an hour apart, starting at `start`. */
export function series(
  type: EventType,
  n: number,
  meta: Record<string, unknown> = {},
  start = new Date('2026-07-01T09:00:00Z'),
): FamiliarEvent[] {
  const out: FamiliarEvent[] = [];
  for (let i = 0; i < n; i++) {
    const at = new Date(start.getTime() + i * 60 * 60 * 1000);
    out.push(
      makeEvent({
        type,
        source: 'manual',
        key: `${type}:series:${i}:${start.getTime()}`,
        at,
        meta: { ...meta },
      }),
    );
  }
  return out;
}

import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deriveState } from '../src/core/xp.js';
import { appendEvent, appendEvents, readEvents, readEventsDetailed } from '../src/state/log.js';
import { eventsPath } from '../src/state/paths.js';
import { ev, useTempHome } from './helpers.js';

let home: ReturnType<typeof useTempHome>;

beforeEach(() => {
  home = useTempHome();
});

afterEach(() => {
  home.cleanup();
});

describe('append and read', () => {
  it('round-trips events', () => {
    const events = [ev('commit'), ev('pr_merged')];
    expect(appendEvents(events)).toHaveLength(2);
    const read = readEvents();
    expect(read).toHaveLength(2);
    expect(read.map((e) => e.type).sort()).toEqual(['commit', 'pr_merged']);
  });

  it('creates the home directory on demand', () => {
    expect(appendEvent(ev('commit'))).toBe(true);
    expect(readEvents()).toHaveLength(1);
  });

  it('returns nothing for a log that does not exist', () => {
    expect(readEvents()).toEqual([]);
    expect(readEventsDetailed().skipped).toBe(0);
  });

  it('survives many sequential appends', () => {
    for (let i = 0; i < 300; i++) appendEvent(ev('commit', { key: `bulk:${i}` }));
    expect(readEvents()).toHaveLength(300);
  });
});

describe('deduplication', () => {
  // The git adapter re-scans on every hook and every CLI call. If this breaks,
  // XP inflates on its own and the whole game is worthless.
  it('refuses to write a key that is already on disk', () => {
    const commit = ev('commit', { key: 'commit:repo:abc123' });
    expect(appendEvents([commit])).toHaveLength(1);
    expect(appendEvents([commit])).toHaveLength(0);
    expect(appendEvents([commit, commit, commit])).toHaveLength(0);
    expect(readEvents()).toHaveLength(1);
  });

  it('keeps XP flat when the same commit is reported repeatedly', () => {
    const commit = ev('commit', { key: 'commit:repo:deadbeef' });
    appendEvents([commit]);
    const first = deriveState(readEvents()).xp;
    for (let i = 0; i < 10; i++) appendEvents([commit]);
    expect(deriveState(readEvents()).xp).toBe(first);
  });

  it('drops duplicates inside a single batch', () => {
    const commit = ev('commit', { key: 'commit:batch:1' });
    expect(appendEvents([commit, commit])).toHaveLength(1);
  });
});

describe('defensive reading', () => {
  function write(contents: string): void {
    writeFileSync(join(home.dir, 'events.jsonl'), contents, 'utf8');
  }

  it('skips a torn final line', () => {
    appendEvents([ev('commit'), ev('pr_merged')]);
    appendFileSync(eventsPath(), '{"t":"2026-07-30T00:00:00.000Z","type":"comm');
    const result = readEventsDetailed();
    expect(result.events).toHaveLength(2);
    expect(result.skipped).toBe(1);
  });

  it('skips garbage lines without throwing', () => {
    appendEvents([ev('commit')]);
    appendFileSync(eventsPath(), '{{{garbage\nnot json at all\n');
    const result = readEventsDetailed();
    expect(result.events).toHaveLength(1);
    expect(result.skipped).toBe(2);
  });

  it('skips well-formed JSON that is not an event', () => {
    write('{"hello":"world"}\n{"type":"not_a_real_type","t":"2026-07-30T00:00:00.000Z","key":"x","source":"manual"}\n');
    const result = readEventsDetailed();
    expect(result.events).toHaveLength(0);
    expect(result.skipped).toBe(2);
  });

  it('tolerates an empty file, blank lines and a BOM', () => {
    write('');
    expect(readEvents()).toEqual([]);

    write('﻿{"t":"2026-07-30T00:00:00.000Z","type":"commit","key":"bom","source":"git","meta":{}}\n\n\n');
    const result = readEventsDetailed();
    expect(result.events).toHaveLength(1);
    expect(result.skipped).toBe(0);
  });

  it('returns events in chronological order regardless of file order', () => {
    write(
      [
        '{"t":"2026-07-30T00:00:00.000Z","type":"commit","key":"b","source":"git","meta":{}}',
        '{"t":"2026-07-01T00:00:00.000Z","type":"commit","key":"a","source":"git","meta":{}}',
        '',
      ].join('\n'),
    );
    expect(readEvents().map((e) => e.key)).toEqual(['a', 'b']);
  });
});

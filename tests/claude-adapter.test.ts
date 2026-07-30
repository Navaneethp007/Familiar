import { describe, expect, it } from 'vitest';

import { classifyTestRun, eventsFromHook } from '../src/adapters/claude-code.js';
import { deriveState } from '../src/core/xp.js';
import { chooseSpeakKey } from '../src/hook.js';
import { ev, series } from './helpers.js';


describe('classifyTestRun', () => {
  it('trusts an explicit exit code above everything else', () => {
    expect(classifyTestRun({ exit_code: 0, stdout: '1 failed' })).toBe('passed');
    expect(classifyTestRun({ exit_code: 1, stdout: 'all tests passed' })).toBe('failed');
    expect(classifyTestRun({ exitCode: 0 })).toBe('passed');
    expect(classifyTestRun({ code: 2 })).toBe('failed');
  });

  it('reads explicit error flags', () => {
    expect(classifyTestRun({ is_error: true })).toBe('failed');
    expect(classifyTestRun({ isError: false })).toBe('passed');
    expect(classifyTestRun({ success: true })).toBe('passed');
    expect(classifyTestRun({ success: false })).toBe('failed');
  });

  it('falls back to output text', () => {
    expect(classifyTestRun({ stdout: 'Tests  12 passed (12)' })).toBe('passed');
    expect(classifyTestRun({ stdout: 'Tests  2 failed | 10 passed' })).toBe('failed');
    expect(classifyTestRun('test result: ok. 8 passed')).toBe('passed');
    expect(classifyTestRun('FAIL tests/a.test.ts')).toBe('failed');
  });

  // Guessing here would fabricate XP, which is worse than missing the event.
  it('returns null when it genuinely cannot tell', () => {
    expect(classifyTestRun(null)).toBeNull();
    expect(classifyTestRun(undefined)).toBeNull();
    expect(classifyTestRun({})).toBeNull();
    expect(classifyTestRun('some unrelated output')).toBeNull();
    expect(classifyTestRun({ interrupted: true })).toBeNull();
    expect(classifyTestRun(42)).toBeNull();
  });
});

describe('eventsFromHook', () => {
  const now = new Date('2026-07-30T02:30:00Z');

  it('emits one session_start per session', () => {
    const events = eventsFromHook({ hook_event_name: 'SessionStart', session_id: 'abc' }, now);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('session_start');
    expect(events[0]?.key).toBe('session_start:abc');

    // Same session redelivered -> same key -> the log will dedupe it.
    const again = eventsFromHook({ hook_event_name: 'SessionStart', session_id: 'abc' }, now);
    expect(again[0]?.key).toBe(events[0]?.key);
  });

  it('emits a check observation for a green run', () => {
    const events = eventsFromHook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_use_id: 'toolu_1',
        tool_input: { command: 'npm test' },
        tool_response: { exit_code: 0 },
        cwd: 'C:\\repos\\thing',
      },
      now,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('check_passed');
    expect(events[0]?.meta['kind']).toBe('test');
    // Claude ran it through its own tool, so attribution is certain here.
    expect(events[0]?.meta['agent']).toBe('claude-code');
    // Slashes normalised so this lands in the same slot as the shell adapter's.
    expect(events[0]?.meta.repoPath).toBe('C:/repos/thing');
  });

  it('emits a failing observation for a red run', () => {
    const events = eventsFromHook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_use_id: 'toolu_2',
        tool_input: { command: 'npx vitest run' },
        tool_response: { exit_code: 1 },
      },
      now,
    );
    expect(events[0]?.type).toBe('check_failed');
  });

  it('classifies builds and typechecks too, not just tests', () => {
    const kindOf = (command: string): unknown =>
      eventsFromHook(
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command },
          tool_response: { exit_code: 0 },
        },
        now,
      )[0]?.meta['kind'];

    expect(kindOf('npm run build')).toBe('build');
    expect(kindOf('tsc --noEmit')).toBe('typecheck');
    expect(kindOf('eslint .')).toBe('lint');
  });

  it('ignores Bash commands that are not checks at all', () => {
    for (const command of ['git status', 'ls -la', 'npm install', 'echo hello']) {
      expect(
        eventsFromHook(
          {
            hook_event_name: 'PostToolUse',
            tool_name: 'Bash',
            tool_input: { command },
            tool_response: { exit_code: 0 },
          },
          now,
        ),
        command,
      ).toHaveLength(0);
    }
  });

  it('ignores a test run whose outcome is unreadable', () => {
    expect(
      eventsFromHook(
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
          tool_response: {},
        },
        now,
      ),
    ).toHaveLength(0);
  });

  // Deliberate: tool use is worth 0 XP, so logging every call is pure bloat.
  it('never emits a tool_used event', () => {
    for (const tool of ['Read', 'Edit', 'Write', 'Glob']) {
      expect(
        eventsFromHook(
          { hook_event_name: 'PostToolUse', tool_name: tool, tool_input: {}, tool_response: {} },
          now,
        ),
      ).toHaveLength(0);
    }
  });

  it('emits nothing for scan-only and unknown hooks', () => {
    for (const name of ['Stop', 'SessionEnd', 'PreToolUse', 'Notification', undefined]) {
      expect(eventsFromHook({ hook_event_name: name }, now)).toHaveLength(0);
    }
  });

  it('does not throw on a malformed payload', () => {
    expect(() =>
      eventsFromHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: undefined }, now),
    ).not.toThrow();
    expect(() => eventsFromHook({} as never, now)).not.toThrow();
  });
});

describe('chooseSpeakKey', () => {
  const quiet = deriveState([]);

  it('says nothing when nothing meaningful happened', () => {
    expect(chooseSpeakKey(quiet, quiet, [])).toBeNull();
    expect(chooseSpeakKey(quiet, quiet, [ev('session_start')])).toBeNull();
    expect(chooseSpeakKey(quiet, quiet, [ev('tool_used')])).toBeNull();
  });

  it('prefers evolution over everything else', () => {
    const before = deriveState(series('commit', 2));
    const after = { ...before, branch: 'night_owl' as const, level: 15, evolvedOn: ev('pr_merged') };
    expect(chooseSpeakKey(before, after, [ev('pr_merged')])?.key).toBe('evolved');
  });

  it('prefers a level up over an ordinary outcome', () => {
    const before = deriveState(series('commit', 2));
    const after = { ...before, level: before.level + 1 };
    expect(chooseSpeakKey(before, after, [ev('commit')])?.key).toBe('level_up');
  });

  it('ranks a merge above a test result', () => {
    expect(chooseSpeakKey(quiet, quiet, [ev('tests_passed'), ev('pr_merged')])?.key).toBe('pr_merged');
  });

  it('flags a late commit as a night commit', () => {
    const night = ev('commit', { meta: { hour: 2 } });
    expect(chooseSpeakKey(quiet, quiet, [night])?.key).toBe('night_commit');

    const day = ev('commit', { meta: { hour: 14 } });
    expect(chooseSpeakKey(quiet, quiet, [day])?.key).toBe('commit');
  });

  it('produces a stable seed so the same batch yields the same line', () => {
    const batch = [ev('pr_merged', { key: 'pr:1' })];
    expect(chooseSpeakKey(quiet, quiet, batch)?.seed).toBe('pr:1');
  });
});

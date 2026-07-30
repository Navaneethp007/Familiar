/**
 * The Claude Code adapter.
 *
 * Reads **only** the documented hook JSON delivered on stdin. It deliberately
 * does not parse `~/.claude/projects/<project>/<session>.jsonl` — that
 * transcript format changes between versions, and building on it would break
 * silently on upgrade.
 *
 * Note what is *not* here: no `tool_used` event is emitted. It is worth 0 XP by
 * design, and writing one line per tool call would bloat the log for no gain.
 * The type stays in the schema for adapters that want it.
 */

import { basename } from 'node:path';

import { makeEvent, type FamiliarEvent } from '../core/events.js';
import { classifyCommand, normaliseRepoPath } from './terminal.js';

export interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  [key: string]: unknown;
}

const FAILURE_TEXT = /\b(\d+\s+fail(ed|ures?)|FAIL\b|tests? failed|assertion(s)? failed|panic:)/i;
const SUCCESS_TEXT = /\b(\d+\s+pass(ed|ing)|all tests passed|PASS\b|ok\b\s+\d+|test result: ok)/i;

/**
 * Decides whether a test run went green.
 *
 * The exact shape of `tool_response` is not fully pinned down in the docs and
 * has changed shape historically, so this reads every plausible signal in order
 * of reliability and **returns null when it genuinely cannot tell**. Guessing
 * would mean fabricating XP, which is worse than missing an event.
 */
export function classifyTestRun(response: unknown): 'passed' | 'failed' | null {
  if (response == null) return null;

  if (typeof response === 'string') {
    if (FAILURE_TEXT.test(response)) return 'failed';
    if (SUCCESS_TEXT.test(response)) return 'passed';
    return null;
  }

  if (typeof response !== 'object') return null;
  const r = response as Record<string, unknown>;

  // 1. An explicit exit code is the only fully trustworthy signal.
  for (const field of ['exit_code', 'exitCode', 'code', 'returncode']) {
    const value = r[field];
    if (typeof value === 'number') return value === 0 ? 'passed' : 'failed';
  }

  // 2. Explicit error flags.
  for (const field of ['is_error', 'isError', 'error']) {
    const value = r[field];
    if (typeof value === 'boolean') return value ? 'failed' : 'passed';
  }
  if (r['success'] === true) return 'passed';
  if (r['success'] === false) return 'failed';

  // 3. Interrupted runs tell us nothing about the tests themselves.
  if (r['interrupted'] === true) return null;

  // 4. Fall back to the captured output text.
  const text = [r['stdout'], r['stderr'], r['output'], r['content'], r['result']]
    .filter((v): v is string => typeof v === 'string')
    .join('\n');
  if (text.length > 0) {
    if (FAILURE_TEXT.test(text)) return 'failed';
    if (SUCCESS_TEXT.test(text)) return 'passed';
  }

  return null;
}

/** Stable-ish identity for a hook occurrence, so re-delivery cannot double-count. */
function occurrenceKey(payload: HookPayload, fallback: string): string {
  return (
    payload.tool_use_id ??
    (payload.session_id ? `${payload.session_id}:${fallback}` : fallback)
  );
}

/**
 * Translates one hook payload into events. Returns an empty array for hooks
 * that exist only to trigger a git scan (Stop, SessionEnd) — the caller does
 * the scanning.
 */
export function eventsFromHook(payload: HookPayload, now = new Date()): FamiliarEvent[] {
  const event = payload.hook_event_name;

  if (event === 'SessionStart') {
    const id = payload.session_id ?? `${now.toISOString()}`;
    return [
      makeEvent({
        type: 'session_start',
        source: 'claude-code',
        key: `session_start:${id}`,
        at: now,
        meta: { repoPath: payload.cwd },
      }),
    ];
  }

  if (event === 'PostToolUse' && payload.tool_name === 'Bash') {
    const command = typeof payload.tool_input?.['command'] === 'string'
      ? (payload.tool_input['command'] as string)
      : '';
    if (!command) return [];

    // Same classifier the terminal adapter uses, so a suite run by Claude and
    // the same suite run by you land in the identical (repo, kind) slot — and
    // a red from one can be fixed by a green from the other.
    const kind = classifyCommand(command);
    if (kind === null) return [];

    const verdict = classifyTestRun(payload.tool_response);
    if (verdict === null) return [];

    const repoPath = payload.cwd ? normaliseRepoPath(payload.cwd) : '';

    return [
      makeEvent({
        type: verdict === 'passed' ? 'check_passed' : 'check_failed',
        source: 'claude-code',
        key: `check:cc:${occurrenceKey(payload, now.toISOString())}`,
        at: now,
        meta: {
          kind,
          command,
          repoPath: repoPath || undefined,
          repo: repoPath ? basename(repoPath) : undefined,
          // The command came through Claude's own tool, so attribution here is
          // certain — unlike the shell adapter, which infers it from an
          // environment variable that can be inherited.
          agent: 'claude-code',
        },
      }),
    ];
  }

  return [];
}

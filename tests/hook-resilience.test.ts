/**
 * The most important tests in the project.
 *
 * Claude Code reads exit code 2 from a `Stop` hook as "do not stop" and from
 * `PreToolUse` as "block the tool". If this process ever exits non-zero it
 * stops being a broken toy and starts being a broken editor. Every one of
 * these cases must exit 0.
 *
 * These run against the built `dist/cli.js`, so `npm run build` must have run.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI = join(process.cwd(), 'dist', 'cli.js');

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runHook(event: string, stdin: string, home: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'hook', `--event=${event}`], {
      env: { ...process.env, FAMILIAR_HOME: home, FAMILIAR_CLAUDE_SETTINGS: join(home, 'settings.json') },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));

    child.stdin.end(stdin);
  });
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'familiar-hook-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('the hook always exits 0', () => {
  it('requires a build first', () => {
    expect(existsSync(CLI), 'run `npm run build` before the test suite').toBe(true);
  });

  it('on a well-formed payload', async () => {
    const payload = JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 'test-session',
      cwd: home,
    });
    expect((await runHook('SessionStart', payload, home)).code).toBe(0);
  });

  it('still reads a payload that arrives with a UTF-8 BOM', async () => {
    const payload = JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_use_id: 'tu_bom',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 0 },
    });
    const result = await runHook('PostToolUse', '﻿' + payload, home);
    expect(result.code).toBe(0);

    const log = readFileSync(join(home, 'events.jsonl'), 'utf8');
    expect(log).toContain('check_passed');
  });

  it('on malformed JSON', async () => {
    expect((await runHook('SessionStart', '{{{not json', home)).code).toBe(0);
  });

  it('on empty stdin', async () => {
    expect((await runHook('Stop', '', home)).code).toBe(0);
  });

  it('on JSON that is not an object', async () => {
    expect((await runHook('Stop', '"just a string"', home)).code).toBe(0);
    expect((await runHook('Stop', '[1,2,3]', home)).code).toBe(0);
    expect((await runHook('Stop', 'null', home)).code).toBe(0);
  });

  it('on an unknown event name', async () => {
    expect((await runHook('SomethingNobodyHasHeardOf', '{}', home)).code).toBe(0);
  });

  it('on a corrupt event log', async () => {
    writeFileSync(join(home, 'events.jsonl'), '{{{garbage\nnot json\n\x00\x01binary\n', 'utf8');
    expect((await runHook('Stop', '{}', home)).code).toBe(0);
  });

  it('on a corrupt config file', async () => {
    writeFileSync(join(home, 'config.json'), 'not json at all', 'utf8');
    expect((await runHook('SessionStart', '{}', home)).code).toBe(0);
  });

  it('when the state directory cannot be created', async () => {
    // A *file* where the home directory should be: every write will fail.
    const blocked = join(home, 'blocked');
    writeFileSync(blocked, 'i am a file, not a directory', 'utf8');
    const result = await runHook('Stop', '{}', blocked);
    expect(result.code).toBe(0);
  });

  it('when cwd points somewhere that does not exist', async () => {
    const payload = JSON.stringify({ hook_event_name: 'Stop', cwd: join(home, 'nope', 'nope') });
    expect((await runHook('Stop', payload, home)).code).toBe(0);
  });

  it('on a PostToolUse payload with a junk tool_response', async () => {
    const payload = JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { nested: { weird: [1, 2, { deep: true }] } },
    });
    expect((await runHook('PostToolUse', payload, home)).code).toBe(0);
  });

  it('prints nothing on stdout, so it cannot be mistaken for hook output', async () => {
    const result = await runHook('Stop', '{}', home);
    expect(result.stdout.trim()).toBe('');
  });
});

describe('the statusline never breaks the footer', () => {
  function runStatusline(home: string): Promise<RunResult> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, 'statusline'], {
        env: { ...process.env, FAMILIAR_HOME: home },
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end('{}');
    });
  }

  it('exits 0 and prints nothing before init', async () => {
    const result = await runStatusline(home);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('exits 0 with a corrupt log', async () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ version: 1, species: 'ember', tone: 'zen', repos: [], createdAt: '' }),
      'utf8',
    );
    writeFileSync(join(home, 'events.jsonl'), '{{{garbage\n', 'utf8');

    const result = await runStatusline(home);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Lv.1');
  });

  it('never writes to the event log', async () => {
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ version: 1, species: 'sprout', tone: 'deadpan', repos: [], createdAt: '' }),
      'utf8',
    );
    await runStatusline(home);
    // Claude Code can kill this script mid-run; it must never be a writer.
    expect(existsSync(join(home, 'events.jsonl'))).toBe(false);
  });
});

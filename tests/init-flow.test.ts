import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runInit } from '../src/init-flow.js';
import { readConfig, readCursors, writeConfig, defaultConfig } from '../src/state/config.js';
import { tempDir, useTempHome } from './helpers.js';

let home: ReturnType<typeof useTempHome>;
let settings: string;

beforeEach(() => {
  home = useTempHome();
  settings = `${tempDir('familiar-settings-')}\\settings.json`;
  process.env['FAMILIAR_CLAUDE_SETTINGS'] = settings;
});

afterEach(() => {
  delete process.env['FAMILIAR_CLAUDE_SETTINGS'];
  home.cleanup();
});

/** Runs init, collecting output, with answers queued on a fake stdin. */
async function init(argv: string[], answers: string[] = [], interactive = answers.length > 0) {
  const lines: string[] = [];
  const input = new PassThrough();
  const output = new PassThrough();
  // Questions go to the output stream; everything else goes through out().
  // Both are "what the user saw", so the assertions read them together.
  let written = '';
  output.on('data', (chunk) => (written += String(chunk)));

  const done = runInit({
    argv,
    out: (line) => lines.push(line),
    cwd: process.cwd(),
    interactive,
    input,
    output,
    env: {},
  });

  setImmediate(() => {
    for (const answer of answers) input.write(answer + '\n');
    input.end();
  });

  await done;
  return { text: `${lines.join('\n')}\n${written}`, config: readConfig() };
}

describe('the non-interactive path', () => {
  it('writes a config and pins every repo, asking nothing', async () => {
    const { text, config } = await init(['--no-claude'], [], false);

    expect(config).not.toBeNull();
    expect(config?.repos.length).toBeGreaterThan(0);
    expect(Object.keys(readCursors()).length).toBe(config?.repos.length);
    expect(text).toContain('your familiar is a');
    expect(text).not.toContain('pick a voice');
  });

  it('leaves tone and colour at their defaults', async () => {
    const { config } = await init(['--no-claude'], [], false);
    expect(config?.tone).toBe('deadpan');
    expect(config?.colour).toBeNull();
  });

  it('refuses to re-seed without --force', async () => {
    await init(['--no-claude'], [], false);
    const { text } = await init(['--no-claude'], [], false);
    expect(text).toContain('already initialised');
  });

  // --quiet has to beat a terminal, not merely stand in for the lack of one.
  it('asks nothing when --quiet is passed even where prompting is possible', async () => {
    const lines: string[] = [];
    await runInit({
      argv: ['--no-claude', '--quiet'],
      out: (l) => lines.push(l),
      interactive: undefined,
      env: {},
      input: Object.assign(new PassThrough(), { isTTY: true }) as never,
    });
    expect(lines.join('\n')).not.toContain('pick a voice');
  });
});

describe('the guided path', () => {
  it('asks for a voice and a colour, and keeps both', async () => {
    const { text, config } = await init(['--no-claude'], ['gremlin', 'ice']);

    expect(text).toContain('pick a voice');
    expect(config?.tone).toBe('gremlin');
    expect(config?.colour).toBe('ice');
  });

  it('accepts numbers as readily as names', async () => {
    const { config } = await init(['--no-claude'], ['4', '1']);
    expect(config?.tone).toBe('gremlin');
    expect(config?.colour).toBe('moss');
  });

  it('takes auto as a real answer meaning follow my species', async () => {
    const { config } = await init(['--no-claude'], ['zen', 'auto']);
    expect(config?.tone).toBe('zen');
    expect(config?.colour).toBeNull();
  });

  it('explains where XP actually comes from', async () => {
    const { text } = await init(['--no-claude'], ['zen', 'auto']);
    expect(text).toContain('OUTCOMES');
    expect(text).toMatch(/a check you FIXED/);
    expect(text).toMatch(/running a tool\s+0/);
  });

  it('still pins cursors, exactly like the quiet path', async () => {
    const { config } = await init(['--no-claude'], ['zen', 'auto']);
    expect(Object.keys(readCursors()).length).toBe(config?.repos.length);
  });

  // Getting this wrong silently resets a returning user's settings, which is
  // worse than failing loudly.
  it('defaults the prompts to what you already had, on --force', async () => {
    const seeded = defaultConfig('sprout');
    seeded.tone = 'hype';
    seeded.colour = 'rose';
    writeConfig(seeded);

    // Empty answers mean "keep it as it is".
    const { config } = await init(['--no-claude', '--force'], ['', '']);
    expect(config?.tone).toBe('hype');
    expect(config?.colour).toBe('rose');
  });

  it('keeps the defaults when the answers run out entirely', async () => {
    const { config } = await init(['--no-claude'], ['']);
    expect(config?.tone).toBe('deadpan');
    expect(config?.colour).toBeNull();
  });
});

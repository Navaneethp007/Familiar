import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import {
  createPrompter,
  isInteractive,
  matchChoice,
  promptChoice,
  promptingAllowed,
  type Choice,
} from '../src/ui/prompt.js';

const TONES: Choice<string>[] = [
  { value: 'hype', label: 'Hype coach' },
  { value: 'deadpan', label: 'Deadpan' },
  { value: 'zen', label: 'Zen master' },
  { value: 'gremlin', label: 'Gremlin' },
];

/** A prompt wired to streams instead of a terminal. */
function ask(script: string[], overrides: Record<string, unknown> = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (c) => (written += String(c)));

  const done = promptChoice({
    question: 'pick a voice',
    choices: TONES,
    defaultValue: 'deadpan',
    input,
    output,
    timeoutMs: 250,
    ...overrides,
  });

  // Feed answers on the next tick so readline is listening first.
  setImmediate(() => {
    for (const line of script) input.write(line + '\n');
    if (script.length === 0) input.end();
  });

  return { done, seen: () => written, input };
}

describe('matchChoice', () => {
  it('takes a 1-based number', () => {
    expect(matchChoice('1', TONES)).toBe('hype');
    expect(matchChoice('4', TONES)).toBe('gremlin');
  });

  it('refuses a number outside the list', () => {
    expect(matchChoice('0', TONES)).toBeNull();
    expect(matchChoice('5', TONES)).toBeNull();
    expect(matchChoice('-1', TONES)).toBeNull();
  });

  it('takes an exact name or label, in any case', () => {
    expect(matchChoice('zen', TONES)).toBe('zen');
    expect(matchChoice('  GREMLIN ', TONES)).toBe('gremlin');
    expect(matchChoice('Hype coach', TONES)).toBe('hype');
  });

  it('takes a prefix only when it picks out exactly one', () => {
    expect(matchChoice('gre', TONES)).toBe('gremlin');
    expect(matchChoice('z', TONES)).toBe('zen');
    // 'deadpan' is the only d-word, so this is unambiguous too.
    expect(matchChoice('d', TONES)).toBe('deadpan');
  });

  it('refuses an ambiguous prefix', () => {
    const ambiguous: Choice<string>[] = [
      { value: 'moss', label: 'Moss' },
      { value: 'mono', label: 'Mono' },
    ];
    expect(matchChoice('mo', ambiguous)).toBeNull();
    expect(matchChoice('mos', ambiguous)).toBe('moss');
  });

  it('treats nothing as nothing', () => {
    expect(matchChoice('', TONES)).toBeNull();
    expect(matchChoice('   ', TONES)).toBeNull();
    expect(matchChoice('banana', TONES)).toBeNull();
  });
});

describe('promptChoice', () => {
  it('returns the chosen value', async () => {
    await expect(ask(['3']).done).resolves.toBe('zen');
  });

  it('accepts a name as readily as a number', async () => {
    await expect(ask(['gremlin']).done).resolves.toBe('gremlin');
  });

  it('re-asks after a bad answer and takes the next one', async () => {
    const a = ask(['banana', 'hype']);
    await expect(a.done).resolves.toBe('hype');
    expect(a.seen()).toContain('didn’t catch');
  });

  it('keeps the default when the line is empty', async () => {
    await expect(ask(['']).done).resolves.toBe('deadpan');
  });

  // Every one of these is a way of saying "there is no answer", and they must
  // all mean the same thing rather than throwing or hanging.
  it('keeps the default at end of input', async () => {
    await expect(ask([]).done).resolves.toBe('deadpan');
  });

  it('keeps the default when nobody answers in time', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const value = await promptChoice({
      question: 'pick a voice',
      choices: TONES,
      defaultValue: 'zen',
      input,
      output,
      timeoutMs: 40,
    });
    expect(value).toBe('zen');
  });

  it('gives up after too many bad answers rather than looping forever', async () => {
    const a = ask(['no', 'nope', 'still no', 'hype'], { maxAttempts: 2 });
    await expect(a.done).resolves.toBe('deadpan');
  });

  it('shows the question and every option', async () => {
    const a = ask(['1']);
    await a.done;
    const seen = a.seen();
    expect(seen).toContain('pick a voice');
    for (const tone of TONES) expect(seen).toContain(tone.label);
  });

  it('never rejects, whatever it is given', async () => {
    for (const script of [[], [''], ['garbage'], ['999']]) {
      await expect(ask(script).done).resolves.toBeDefined();
    }
  });
});

describe('a prompter asked more than once', () => {
  const CHOICES: Choice<string>[] = [
    { value: 'a', label: 'Ay' },
    { value: 'b', label: 'Bee' },
  ];

  /** The prompt's own timer is unref'd, so hold the loop open like real stdin does. */
  function held<T>(run: () => Promise<T>): Promise<T> {
    const keepAlive = setInterval(() => undefined, 20);
    return run().finally(() => clearInterval(keepAlive));
  }

  // The bug this guards: a timed-out question used to stay queued as a waiter
  // that had already resolved. The next line was handed to that corpse and
  // silently dropped, so in guided init one distraction during the tone
  // question lost the colour answer as well — both settings gone, no error.
  it('still hears the next answer after a question times out', async () => {
    await held(async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      const prompter = createPrompter({ input, output, timeoutMs: 100 });

      const first = await prompter.choice({
        question: 'first',
        choices: CHOICES,
        defaultValue: 'default-1',
        maxAttempts: 1,
      });
      expect(first).toBe('default-1');

      const second = prompter.choice({
        question: 'second',
        choices: CHOICES,
        defaultValue: 'default-2',
        maxAttempts: 1,
      });
      setTimeout(() => input.write('b\n'), 10);

      expect(await second).toBe('b');
      prompter.close();
    });
  });

  it('carries answers across questions in order', async () => {
    await held(async () => {
      const input = new PassThrough();
      const output = new PassThrough();
      const prompter = createPrompter({ input, output, timeoutMs: 500 });

      setImmediate(() => input.write('b\na\n'));

      const first = await prompter.choice({
        question: 'first',
        choices: CHOICES,
        defaultValue: 'x',
      });
      const second = await prompter.choice({
        question: 'second',
        choices: CHOICES,
        defaultValue: 'x',
      });

      expect([first, second]).toEqual(['b', 'a']);
      prompter.close();
    });
  });
});

describe('deciding whether to ask at all', () => {
  it('needs a terminal on both ends', () => {
    expect(isInteractive({ isTTY: true }, { isTTY: true })).toBe(true);
    expect(isInteractive({ isTTY: false }, { isTTY: true })).toBe(false);
    expect(isInteractive({ isTTY: true }, { isTTY: false })).toBe(false);
    expect(isInteractive({}, {})).toBe(false);
  });

  // A pseudo-terminal is not a person. Without these, an automated `init` would
  // wait out the full timeout on every run.
  it('refuses when the environment says nobody is watching', () => {
    const tty = { isTTY: true };
    expect(promptingAllowed({}, tty, tty)).toBe(true);
    expect(promptingAllowed({ CI: 'true' }, tty, tty)).toBe(false);
    expect(promptingAllowed({ FAMILIAR_NO_PROMPT: '1' }, tty, tty)).toBe(false);
  });

  it('refuses when there is no terminal, whatever the environment', () => {
    expect(promptingAllowed({}, { isTTY: false }, { isTTY: false })).toBe(false);
  });
});

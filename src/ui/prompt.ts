/**
 * Asking a question, exactly once, at the only moment it is welcome.
 *
 * Familiar is a background thing: hooks, a footer line, a spool file. `init` is
 * the single point where a person is looking at it and expecting a
 * conversation. Everything here exists to make that one moment work and to make
 * absolutely sure it never happens anywhere else.
 *
 * Two rules the implementation is built around:
 *
 * 1. **It must never reject.** `init` has already written nothing by the time it
 *    prompts, but it is about to. A prompt that throws would be the one thing
 *    able to abort init half-configured. Empty input, EOF, a timeout and
 *    exhausted retries all resolve the default instead.
 * 2. **It must always terminate.** A timeout covers silence; a retry cap covers
 *    a stream that answers with garbage forever. Either alone leaves a hang.
 */

import { createInterface } from 'node:readline';

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
}

export interface PromptDeps {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** Per question. Zero or less disables it. */
  timeoutMs?: number;
}

export interface ChoiceOptions<T> extends PromptDeps {
  question: string;
  choices: readonly Choice<T>[];
  /** Returned on an empty line, EOF, a timeout, or too many bad answers. */
  defaultValue: T;
  maxAttempts?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Whether a real person is on both ends.
 *
 * Takes its inputs as arguments rather than reading `process`, the same way
 * `detectCaps` does in sprite-term.ts — it is what makes every branch testable
 * without a real terminal.
 */
export function isInteractive(
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout,
): boolean {
  return Boolean(stdin?.isTTY) && Boolean(stdout?.isTTY);
}

/**
 * Whether prompting is allowed at all, beyond merely being possible.
 *
 * A pseudo-terminal is not the same thing as a person. `docker run -t` and some
 * CI runners set isTTY on both ends, and without these escapes every automated
 * `familiar init` would sit waiting for an answer nobody is there to give.
 */
export function promptingAllowed(
  env: Record<string, string | undefined> = process.env,
  stdin?: { isTTY?: boolean },
  stdout?: { isTTY?: boolean },
): boolean {
  // Both are checked for presence rather than value, so `CI=false` still
  // suppresses prompting. That is the deliberate direction: the cost of not
  // asking is a default, and the cost of asking wrongly is a build that hangs.
  if (env['FAMILIAR_NO_PROMPT']) return false;
  if (env['CI']) return false;
  return isInteractive(stdin ?? process.stdin, stdout ?? process.stdout);
}

function render<T>(choices: readonly Choice<T>[]): string {
  return choices
    .map((c, i) => `    ${i + 1}  ${c.label}${c.hint ? `  — ${c.hint}` : ''}`)
    .join('\n');
}

/**
 * Resolves an answer to a choice, or null if it matches nothing.
 *
 * Order matters: a number is unambiguous, an exact name beats a prefix, and a
 * prefix only counts when it picks out exactly one option.
 */
export function matchChoice<T>(answer: string, choices: readonly Choice<T>[]): T | null {
  const text = answer.trim().toLowerCase();
  if (text.length === 0) return null;

  const index = /^\d+$/.test(text) ? Number.parseInt(text, 10) : NaN;
  if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
    return (choices[index - 1] as Choice<T>).value;
  }

  const exact = choices.find(
    (c) => String(c.value).toLowerCase() === text || c.label.toLowerCase() === text,
  );
  if (exact) return exact.value;

  const prefixed = choices.filter((c) => String(c.value).toLowerCase().startsWith(text));
  return prefixed.length === 1 ? (prefixed[0] as Choice<T>).value : null;
}

export interface Prompter {
  choice<T>(options: Omit<ChoiceOptions<T>, keyof PromptDeps>): Promise<T>;
  close(): void;
}

/**
 * Opens one conversation, however many questions it turns out to hold.
 *
 * One readline interface for the whole flow, not one per question. Readline
 * buffers greedily: ask twice through two interfaces and the first swallows
 * everything the other end has already sent, leaving the second waiting on an
 * empty stream until its timeout. Sharing the queue is what makes a second
 * question possible at all.
 *
 * The caller must `close()`. An open interface holds stdin, and a `familiar
 * init` that prints its whole summary and then never exits is a worse bug than
 * any of the ones this flow is meant to prevent.
 */
export function createPrompter(deps: PromptDeps = {}): Prompter {
  const input = deps.input ?? process.stdin;
  const output = deps.output ?? process.stdout;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const rl = createInterface({ input, output });

  const queued: string[] = [];
  const waiting: Array<(line: string | null) => void> = [];
  let ended = false;

  rl.on('line', (line: string) => {
    const waiter = waiting.shift();
    if (waiter) waiter(line);
    else queued.push(line);
  });
  rl.on('close', () => {
    ended = true;
    while (waiting.length > 0) (waiting.shift() as (l: string | null) => void)(null);
  });

  /** The next line, or null for end-of-input or silence. */
  function nextLine(): Promise<string | null> {
    const buffered = queued.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (ended) return Promise.resolve(null);

    return new Promise<string | null>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const settle = (line: string | null): void => {
        if (settled) return;
        settled = true;

        // Take this waiter out of the queue. Without it a timed-out question
        // stays queued as a corpse, and the *next* question's answer is handed
        // to it and dropped on the floor — so one distraction during the first
        // prompt silently loses the answer to the second one too.
        const index = waiting.indexOf(settle);
        if (index >= 0) waiting.splice(index, 1);

        if (timer) clearTimeout(timer);
        resolve(line);
      };

      waiting.push(settle);

      if (timeoutMs > 0) {
        timer = setTimeout(() => settle(null), timeoutMs);
        // A pending prompt must never be the reason a process stays alive.
        timer.unref?.();
      }
    });
  }

  return {
    async choice<T>(options: Omit<ChoiceOptions<T>, keyof PromptDeps>): Promise<T> {
      const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
      try {
        output.write(`\n  ${options.question}\n${render(options.choices)}\n`);

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          output.write('  > ');
          const answer = await nextLine();

          // Null covers every "there is no answer" case — end of input,
          // silence — and they all mean the same thing: leave it as it was.
          if (answer === null) return options.defaultValue;

          const matched = matchChoice(answer, options.choices);
          if (matched !== null) return matched;

          output.write(`  didn’t catch "${answer.trim()}" — pick a number or a name\n`);
        }

        return options.defaultValue;
      } catch {
        return options.defaultValue;
      }
    },
    close(): void {
      rl.close();
    },
  };
}

/** A single question, start to finish. Convenience over `createPrompter`. */
export async function promptChoice<T>(options: ChoiceOptions<T>): Promise<T> {
  const prompter = createPrompter(options);
  try {
    return await prompter.choice(options);
  } finally {
    prompter.close();
  }
}

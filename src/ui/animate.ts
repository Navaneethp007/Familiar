/**
 * Blinking the sprite in place.
 *
 * Split out from both `cli.ts` and `sprite-term.ts` on purpose. The renderer
 * next door is pure and needs to stay that way; this writes escape codes to a
 * real terminal and sleeps. The CLI is a dispatch layer and should not be where
 * cursor arithmetic lives — especially arithmetic that has to agree with
 * SPRITE_TEXT_ROWS, which is imported here so the two cannot drift apart.
 */

import { SPRITE_TEXT_ROWS } from './sprite-term.js';

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

/**
 * Back to the top of the sprite block, and no further.
 *
 * Cursor-up is only correct over a region that has not scrolled. Restricting
 * the redraw to exactly the sprite's own rows — and printing anything else
 * *after* the animation finishes — is what keeps this from smearing frames
 * across the prompt in a short terminal.
 */
const CURSOR_UP = `\x1b[${SPRITE_TEXT_ROWS}A`;

/** Matches the widget's blink, so it is recognisably the same creature. */
const CLOSED_MS = 130;
const OPEN_MS = 420;
const BLINKS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BlinkOptions {
  write?: (text: string) => void;
  blinks?: number;
}

/**
 * Alternates the two frames a few times, then settles on the open one.
 *
 * The cursor is restored on the way out *and* on SIGINT: a Ctrl-C mid-animation
 * would otherwise leave the caret invisible until the user thought to run
 * `reset`, which is a rude thing for a toy to do to someone's terminal.
 */
export async function blinkSprite(
  open: string,
  closed: string,
  options: BlinkOptions = {},
): Promise<void> {
  const write = options.write ?? ((text: string) => void process.stdout.write(text));
  const restore = (): void => write(SHOW_CURSOR);
  const onInterrupt = (): void => {
    restore();
    process.exit(130);
  };

  write(HIDE_CURSOR);
  process.once('SIGINT', onInterrupt);
  try {
    write(open + '\n');
    for (let i = 0; i < (options.blinks ?? BLINKS); i++) {
      await sleep(OPEN_MS);
      write(CURSOR_UP + closed + '\n');
      await sleep(CLOSED_MS);
      write(CURSOR_UP + open + '\n');
    }
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    restore();
  }
}

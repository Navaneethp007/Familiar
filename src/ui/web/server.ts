/**
 * `familiar show` — a browser page for the creature.
 *
 * This is the one long-lived-ish piece, and it is deliberately the smallest
 * version of that: bound to 127.0.0.1 on an ephemeral port, started only when
 * you ask to look, and shut down once the page stops polling. Nothing
 * autostarts, nothing survives a reboot, nothing runs while you are not
 * looking. A server exists at all only because a browser cannot read
 * ~/.familiar from a file:// page.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formIdentity } from '../../core/forms.js';
import { BRANCH_LABELS } from '../../core/habits.js';
import { SPECIES_BLURBS, SPECIES_LABELS } from '../../core/species.js';
import { blink, gridFor } from '../../core/sprites/grids.js';
import {
  COLOURS,
  COLOUR_LABELS,
  COLOUR_PALETTES,
  MOOD_TINTS,
  paletteFor,
  type ColourName,
} from '../../core/sprites/palettes.js';
import { TONES, TONE_LABELS, type ToneName } from '../../core/tone.js';
import { deriveState, weeklyTotals } from '../../core/xp.js';
import { scanAll } from '../../adapters/git.js';
import { drainShellLog } from '../../adapters/terminal.js';
import { logError, readOrCreateConfig, writeConfig } from '../../state/config.js';
import { appendEvents, readEvents } from '../../state/log.js';
import { freshQuip } from '../statusline.js';

/** No poll for this long means the tab is gone. */
const IDLE_SHUTDOWN_MS = 10_000;

function pagePath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'page.html');
}

function buildPayload(): unknown {
  // Cheap, and it makes the page live: commit in another terminal and the
  // creature reacts on the next poll.
  try {
    appendEvents([...drainShellLog(), ...scanAll()]);
  } catch (error) {
    logError('web:ingest', error);
  }

  const config = readOrCreateConfig();
  const events = readEvents();
  const state = deriveState(events, { species: config.species });
  const form = formIdentity(state.species, state.stage, state.branch);

  const grid = gridFor(state.species, state.stage, state.branch);

  return {
    form: {
      name: form.name,
      emoji: form.emoji,
      stage: state.stage,
      branch: state.branch,
      branchLabel: state.branch ? BRANCH_LABELS[state.branch] : null,
      species: state.species,
      speciesLabel: SPECIES_LABELS[state.species],
      speciesBlurb: SPECIES_BLURBS[state.species],
    },
    sprite: {
      grid,
      blink: blink(grid),
      palette: paletteFor(state.species, state.branch, config.colour),
      tint: MOOD_TINTS[state.mood],
    },
    level: state.level,
    xp: state.xp,
    levelFloor: state.levelFloor,
    nextLevelAt: state.nextLevelAt,
    progress: state.progress,
    habits: state.habits,
    checks: state.checks,
    mood: state.mood,
    totals: state.totals,
    week: weeklyTotals(events),
    quip: freshQuip(),
    tone: config.tone,
    tones: TONES.map((t) => ({ id: t, label: TONE_LABELS[t] })),
    colour: config.colour,
    colours: COLOURS.map((c) => ({
      id: c,
      label: COLOUR_LABELS[c],
      // The swatch shows the body stroke, which is what actually changes.
      swatch: COLOUR_PALETTES[c]['2'],
    })),
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 4096) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

export interface ShowOptions {
  open?: boolean;
  /** Overridable for tests, which need a server they can shut down themselves. */
  idleShutdownMs?: number;
}

export interface RunningWidget {
  url: string;
  close: () => void;
}

export function startWidget(options: ShowOptions = {}): Promise<RunningWidget> {
  const idleMs = options.idleShutdownMs ?? IDLE_SHUTDOWN_MS;
  let lastPoll = Date.now();

  const server = createServer((req, res) => {
    const url = req.url ?? '/';

    try {
      if (url.startsWith('/api/state')) {
        lastPoll = Date.now();
        sendJson(res, 200, buildPayload());
        return;
      }

      if (url.startsWith('/api/tone') && req.method === 'POST') {
        lastPoll = Date.now();
        void readBody(req).then((body) => {
          try {
            const parsed = JSON.parse(body || '{}') as { tone?: string };
            const tone = parsed.tone;
            if (tone && (TONES as readonly string[]).includes(tone)) {
              const config = readOrCreateConfig();
              config.tone = tone as ToneName;
              writeConfig(config);
              sendJson(res, 200, { ok: true, tone });
              return;
            }
            sendJson(res, 400, { ok: false, error: 'unknown tone' });
          } catch {
            sendJson(res, 400, { ok: false, error: 'bad request' });
          }
        });
        return;
      }

      if (url.startsWith('/api/colour') && req.method === 'POST') {
        lastPoll = Date.now();
        void readBody(req).then((body) => {
          try {
            const parsed = JSON.parse(body || '{}') as { colour?: string | null };
            const colour = parsed.colour;
            // null is a legitimate value here — it means "follow my species".
            if (colour === null || colour === 'default') {
              const config = readOrCreateConfig();
              config.colour = null;
              writeConfig(config);
              sendJson(res, 200, { ok: true, colour: null });
              return;
            }
            if (colour && (COLOURS as readonly string[]).includes(colour)) {
              const config = readOrCreateConfig();
              config.colour = colour as ColourName;
              writeConfig(config);
              sendJson(res, 200, { ok: true, colour });
              return;
            }
            sendJson(res, 400, { ok: false, error: 'unknown colour' });
          } catch {
            sendJson(res, 400, { ok: false, error: 'bad request' });
          }
        });
        return;
      }

      if (url === '/' || url.startsWith('/index')) {
        lastPoll = Date.now();
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(readFileSync(pagePath(), 'utf8'));
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (error) {
      logError('web:request', error);
      try {
        sendJson(res, 500, { error: 'internal' });
      } catch {
        /* response already gone */
      }
    }
  });

  const idleTimer = setInterval(() => {
    if (Date.now() - lastPoll > idleMs) {
      clearInterval(idleTimer);
      server.close();
    }
  }, 1_000);
  idleTimer.unref?.();

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const url = `http://127.0.0.1:${port}/`;

      if (options.open !== false) openBrowser(url);

      resolve({
        url,
        close: () => {
          clearInterval(idleTimer);
          server.close();
        },
      });
    });
  });
}

function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    const [command, args] =
      platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : platform === 'darwin'
          ? ['open', [url]]
          : ['xdg-open', [url]];

    const child = spawn(command as string, args as string[], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch (error) {
    // Not being able to launch a browser is not a reason to fail — the URL is
    // printed either way.
    logError('web:open-browser', error);
  }
}

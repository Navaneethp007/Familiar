/**
 * First run.
 *
 * Familiar spends the rest of its life in the background — a footer line, a
 * spool file, four hooks. `init` is the only moment somebody is looking
 * straight at it, which makes it the only chance to explain the one rule the
 * whole project turns on: XP comes from outcomes, never from activity. A README
 * cannot do that job, because nobody reads a README at the moment they care.
 *
 * Lives here rather than in `core/` because it writes files and asks questions;
 * `core/` is pure by contract. It lives outside cli.ts so both paths through it
 * can be tested without building `dist` or spawning a process.
 */

import { homedir } from 'node:os';
import { dirname } from 'node:path';

import {
  commitDatesSince,
  configuredEmail,
  discoverRepos,
  findRepoRoot,
  headSha,
} from './adapters/git.js';
import { profileRhythm, selectSpecies, SPECIES_BLURBS, SPECIES_LABELS } from './core/species.js';
import { fixXp } from './core/checks.js';
import { gridFor } from './core/sprites/grids.js';
import { COLOURS, COLOUR_LABELS, paletteFor, type ColourName } from './core/sprites/palettes.js';
import { TONES, TONE_LABELS, type ToneName } from './core/tone.js';
import { XP_TABLE } from './core/xp.js';
import { installClaudeIntegration, isEphemeralEntrypoint } from './install.js';
import {
  defaultConfig,
  logError,
  readConfig,
  writeConfig,
  writeCursors,
  type CursorFile,
  type FamiliarConfig,
} from './state/config.js';
import { ensureHome } from './state/log.js';
import { createPrompter, promptingAllowed } from './ui/prompt.js';
import { detectCaps, renderSprite } from './ui/sprite-term.js';

const SEED_WINDOW_DAYS = 60;

/**
 * Seeds a species from recent history.
 *
 * Reads *rhythm only* — how often and how evenly commits land — and never
 * awards a single point of XP. Per the design: history seeds personality, not
 * level. A creature that starts maxed has skipped the entire game.
 */
export function seedSpecies(cwd: string): {
  species: ReturnType<typeof selectSpecies>;
  repos: string[];
  commits: number;
} {
  const here = findRepoRoot(cwd);
  const roots = [homedir(), cwd, dirname(cwd)];
  if (here) roots.push(dirname(here));

  const repos = discoverRepos(roots);
  if (here && !repos.includes(here)) repos.push(here);

  const email = configuredEmail(cwd);
  const dates: Date[] = [];
  for (const repo of repos) {
    dates.push(...commitDatesSince(repo, SEED_WINDOW_DAYS, email));
  }

  const profile = profileRhythm(dates, SEED_WINDOW_DAYS);
  return { species: selectSpecies(profile), repos, commits: dates.length };
}

/** Everything about the screen the egg gets drawn on. */
export interface TerminalInfo {
  isTTY: boolean;
  platform: NodeJS.Platform;
  rows?: number;
}

export interface InitDeps {
  argv: string[];
  out: (line: string) => void;
  cwd?: string;
  /** Overridable so tests can drive both paths without a terminal. */
  interactive?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  env?: Record<string, string | undefined>;
  screen?: TerminalInfo;
}

/**
 * The briefing.
 *
 * Numbers come from the XP table rather than being written out, so this can
 * never quietly disagree with what the engine actually pays.
 */
function explain(out: (line: string) => void, species: ReturnType<typeof selectSpecies>): void {
  out('');
  out(`  you have a ${SPECIES_LABELS[species]}.`);
  out(`  ${SPECIES_BLURBS[species]}`);
  out('');
  out('  your git history picked that, and that is all it picked — the level');
  out('  starts at 1 like everyone else’s.');
  out('');
  out('  from here XP comes from OUTCOMES, never from activity:');
  out(`      a commit                    ${String(XP_TABLE.commit).padStart(3)}`);
  out(`      a merged PR                 ${String(XP_TABLE.pr_merged).padStart(3)}`);
  out(`      a check you FIXED           ${String(fixXp(1)).padStart(3)}`);
  out(`      running a tool                0`);
  out(`      a test that was already green 0`);
  out('');
  out('  nothing you can do more of is worth more. only fixing more things is.');
}

/**
 * Draws the egg it just seeded, at whatever fidelity the terminal allows.
 *
 * The terminal is described entirely by arguments rather than read from
 * `process`, so the guided path can be rendered against a fake one — the same
 * reason `detectCaps` takes its inputs instead of sniffing them.
 */
function drawEgg(
  out: (line: string) => void,
  species: ReturnType<typeof selectSpecies>,
  colour: ColourName | null,
  env: Record<string, string | undefined>,
  screen: TerminalInfo,
): void {
  const caps = detectCaps(env, screen.isTTY, screen.platform, screen.rows);
  out('');
  out(
    renderSprite({
      grid: gridFor(species, 'egg', null),
      palette: paletteFor(species, null, colour),
      caps,
    }),
  );
}

export async function runInit(deps: InitDeps): Promise<void> {
  const { argv, out } = deps;
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const force = argv.includes('--force');
  const skipClaude = argv.includes('--no-claude');
  const quiet = argv.includes('--quiet');

  // --quiet wins outright; otherwise the environment gets a veto before we even
  // look at whether a terminal is attached.
  const interactive =
    deps.interactive ??
    (!quiet && promptingAllowed(env, deps.input as { isTTY?: boolean } | undefined, process.stdout));

  ensureHome();

  const existing = readConfig();
  if (existing && !force) {
    out('');
    out('  Familiar is already initialised.');
    out(`  Species: ${SPECIES_LABELS[existing.species]}  ·  tone: ${TONE_LABELS[existing.tone]}`);
    out('  Re-run with --force to re-seed (this does not touch your event log).');
    out('');
    return;
  }

  out('');
  out('  reading your recent git rhythm…');
  const { species, repos, commits } = seedSpecies(cwd);

  const config: FamiliarConfig = existing ? { ...existing, species } : defaultConfig(species);
  config.repos = repos;

  // Sample HEAD *before* any prompt. Pinning is what stops the first scan
  // replaying years of commits as XP, and with a person deciding a colour in
  // between, a commit made in another window would otherwise be pinned away and
  // never score.
  const cursors: CursorFile = {};
  const now = new Date().toISOString();
  for (const repo of repos) {
    cursors[repo] = { lastSha: headSha(repo), lastScan: now };
  }

  out(`  found ${commits} commits across ${repos.length} repo(s) in the last ${SEED_WINDOW_DAYS} days`);

  if (interactive) {
    const screen: TerminalInfo = deps.screen ?? {
      isTTY: Boolean(process.stdout.isTTY),
      platform: process.platform,
      rows: process.stdout.rows,
    };
    drawEgg(out, species, config.colour, env, screen);
    explain(out, species);

    // One prompter for both questions — see the note in prompt.ts about why two
    // interfaces lose the second answer. Closed in `finally` so init can exit.
    const prompter = createPrompter({ input: deps.input, output: deps.output });
    try {
      // Defaults are the *current* values, so re-running with --force never
      // silently resets a returning user's settings.
      config.tone = await prompter.choice<ToneName>({
        question: 'pick a voice for it',
        choices: TONES.map((t) => ({ value: t, label: TONE_LABELS[t] })),
        defaultValue: config.tone,
      });

      config.colour = await prompter.choice<ColourName | null>({
        question: 'pick a colour (or ‘auto’ to follow your species)',
        choices: [
          ...COLOURS.map((c) => ({ value: c as ColourName | null, label: COLOUR_LABELS[c] })),
          { value: null, label: 'auto', hint: 'whatever your species is' },
        ],
        defaultValue: config.colour,
      });
    } finally {
      prompter.close();
    }
  } else {
    out('');
    out(`  🥚  your familiar is a ${SPECIES_LABELS[species]} egg`);
    out(`      ${SPECIES_BLURBS[species]}`);
    out('');
    out('  history seeded its personality, not its level — it starts at Lv.1 like everyone else.');
  }

  writeConfig(config);
  writeCursors(cursors);
  out('');

  if (skipClaude) {
    out('  skipped Claude Code wiring (--no-claude)');
    out('');
    return;
  }

  // Everything above this point is path-independent: it lives in ~/.familiar and
  // survives however this was run. Wiring is not — it records the absolute path
  // of *this* copy, so doing it from a throwaway npx cache produces settings
  // that break silently the moment that cache is pruned. Refuse rather than
  // leave a trap behind; the species, config and cursors are already saved.
  if (isEphemeralEntrypoint()) {
    out('  NOT wiring into Claude Code — this copy is running from a temporary');
    out('  cache (npx), and the hooks would record a path that stops existing.');
    out('');
    out('  install it properly, then run init again:');
    out('    npm install -g witch-familiar');
    out('    familiar init');
    out('');
    out('  your species and settings are saved either way.');
    out('');
    return;
  }

  try {
    const result = installClaudeIntegration({ force });
    config.claudeInstalled = true;
    writeConfig(config);

    out(`  wired into ${result.settingsPath}`);
    if (result.backup) out(`  backup saved to ${result.backup}`);
    out(`  hooks: ${result.hooksAdded.join(', ')}`);
    if (result.statusLineInstalled) {
      out('  statusline: installed');
    } else if (result.statusLineSkipped) {
      out('  statusline: SKIPPED — you already have one. Re-run with --force to replace it.');
    }
    out('');
    out('  restart Claude Code to see it.');
    if (interactive) out('  and try `familiar look` any time.');
  } catch (error) {
    logError('init:install', error);
    out(`  could not wire into Claude Code: ${(error as Error).message}`);
    out('  everything else still works — the git adapter needs no setup.');
  }
  out('');
}

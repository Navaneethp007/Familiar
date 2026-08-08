#!/usr/bin/env node
/**
 * The CLI — the doorway, not the creature.
 *
 * Every command that renders something also runs a cheap incremental git scan
 * first, which is why there is no `familiar refresh`: looking at your familiar
 * is what brings it up to date.
 */

import { scanAll } from './adapters/git.js';
import { blink, gridFor } from './core/sprites/grids.js';
import { COLOURS, COLOUR_LABELS, paletteFor, type ColourName } from './core/sprites/palettes.js';
import { TONES, TONE_LABELS, type ToneName } from './core/tone.js';
import { deriveState } from './core/xp.js';
import { drainShellLog } from './adapters/terminal.js';
import { realVoiceEnv, speakAloud, voiceCommandFor } from './adapters/voice.js';
import { runHook } from './hook.js';
import { runInit } from './init-flow.js';
import {
  installShell,
  shellStatus,
  SHELL_LABELS,
  SHELLS,
  uninstallShell,
  type ShellName,
} from './shell/install.js';
import { POLICY_FIX_COMMAND } from './shell/policy.js';
import { cliEntrypoint, uninstallClaudeIntegration } from './install.js';
import { logError, readConfig, readOrCreateConfig, writeConfig } from './state/config.js';
import { appendEvents, ensureHome, readEventsDetailed } from './state/log.js';
import { claudeSettingsPath, familiarHome } from './state/paths.js';
import { blinkSprite } from './ui/animate.js';
import {
  detectCaps,
  frameWidth,
  renderIdentity,
  renderSprite,
  renderSpriteFull,
  SPRITE_FULL_ROWS,
  tintPalette,
} from './ui/sprite-term.js';
import { renderStatusCard } from './ui/status-card.js';
import { freshQuip, renderStatusline } from './ui/statusline.js';
import { startWidget } from './ui/web/server.js';

function out(text: string): void {
  process.stdout.write(text + '\n');
}

function argValue(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = argv.find((a) => a.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  if (index >= 0) return argv[index + 1];
  return undefined;
}

// --- init ------------------------------------------------------------------

/** The flow itself lives in init-flow.ts, where both paths through it are testable. */
async function cmdInit(argv: string[]): Promise<void> {
  await runInit({ argv, out });
}

// --- status ----------------------------------------------------------------

function cmdStatus(argv: string[]): void {
  const config = readOrCreateConfig();

  try {
    appendEvents([...drainShellLog(), ...scanAll()]);
  } catch (error) {
    logError('status:ingest', error);
  }

  const { events, skipped } = readEventsDetailed();
  const state = deriveState(events, { species: config.species });

  out(
    renderStatusCard({
      state,
      events,
      tone: config.tone,
      voice: config.voice,
      quip: freshQuip() ?? undefined,
      skippedLines: skipped,
    }),
  );

  if (argv.includes('--debug')) {
    out(`  home:   ${familiarHome()}`);
    out(`  claude: ${claudeSettingsPath()}`);
    out(`  repos:  ${config.repos.length}`);
    out('');
  }
}

// --- statusline ------------------------------------------------------------

/**
 * Invoked by Claude Code many times a minute. Read-only and defensive: if
 * anything at all goes wrong it prints nothing rather than an error, because a
 * stack trace in the footer is worse than an empty footer.
 */
function cmdStatusline(): void {
  try {
    const config = readConfig();
    if (!config) return;
    const { events } = readEventsDetailed();
    out(
      renderStatusline({
        events,
        species: config.species,
        tone: config.tone,
        quip: freshQuip(),
      }),
    );
  } catch (error) {
    logError('statusline', error);
  }
}

// --- tone ------------------------------------------------------------------

function cmdTone(argv: string[]): void {
  const config = readOrCreateConfig();
  const requested = argv[0];

  if (!requested) {
    out('');
    out(`  current tone: ${TONE_LABELS[config.tone]}`);
    out('');
    for (const tone of TONES) {
      out(`    ${tone === config.tone ? '●' : '○'} ${tone.padEnd(8)} ${TONE_LABELS[tone]}`);
    }
    out('');
    out('  usage: familiar tone <name>');
    out('');
    return;
  }

  if (!(TONES as readonly string[]).includes(requested)) {
    out(`  unknown tone "${requested}". options: ${TONES.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  config.tone = requested as ToneName;
  writeConfig(config);
  out(`  tone set to ${TONE_LABELS[config.tone]}`);
}

// --- show ------------------------------------------------------------------

async function cmdShow(): Promise<void> {
  readOrCreateConfig();
  const widget = await startWidget({ open: true });
  out('');
  out(`  your familiar is at ${widget.url}`);
  out('  this server shuts down on its own once you close the tab.');
  out('');
}

// --- colour ----------------------------------------------------------------

/**
 * The only thing about your familiar you get to choose.
 *
 * Species comes from your git rhythm and branch from your habits — both earned,
 * neither picked. Colour is worth no XP and changes nothing but the look.
 */
function cmdColour(argv: string[]): void {
  const config = readOrCreateConfig();
  const requested = argv[0];

  if (!requested) {
    out('');
    out(`  current colour: ${config.colour ? COLOUR_LABELS[config.colour] : 'your species’ own'}`);
    out('');
    for (const colour of COLOURS) {
      out(`    ${colour === config.colour ? '●' : '○'} ${colour.padEnd(8)} ${COLOUR_LABELS[colour]}`);
    }
    out(`    ${config.colour === null ? '●' : '○'} ${'default'.padEnd(8)} whatever your species is`);
    out('');
    out('  usage: familiar colour <name|default>');
    out('');
    return;
  }

  if (requested === 'default') {
    config.colour = null;
    writeConfig(config);
    out('  colour follows your species again');
    return;
  }

  if (!(COLOURS as readonly string[]).includes(requested)) {
    out(`  unknown colour "${requested}". options: ${COLOURS.join(', ')}, default`);
    process.exitCode = 1;
    return;
  }

  config.colour = requested as ColourName;
  writeConfig(config);
  out(`  colour set to ${COLOUR_LABELS[config.colour]}`);
}

// --- look ------------------------------------------------------------------

async function cmdLook(argv: string[]): Promise<void> {
  const config = readOrCreateConfig();

  // The module header is not kidding: looking at your familiar is the refresh.
  try {
    appendEvents([...drainShellLog(), ...scanAll()]);
  } catch (error) {
    logError('look:ingest', error);
  }

  const { events } = readEventsDetailed();
  const state = deriveState(events, { species: config.species });

  const caps = detectCaps(
    process.env,
    Boolean(process.stdout.isTTY),
    process.platform,
    process.stdout.rows,
    process.stdout.columns,
  );

  const grid = gridFor(state.species, state.stage, state.branch);
  const palette = tintPalette(
    paletteFor(state.species, state.branch, config.colour),
    state.mood,
  );

  // Full resolution by default: one text row per pixel row, so the terminal
  // shows exactly what the widget does. The half-block fold is half the height
  // but also half the vertical detail, which on 1px strokes is most of the
  // drawing — so it is the fallback, not the default.
  //
  // Width is checked as well as height. Full-res is 34 columns against the
  // fold's 18, so a narrow split pane can be plenty tall and still wrap every
  // line — and a wrapped frame occupies more physical rows than it has lines,
  // which is precisely what the animation cannot survive.
  const tooShort = caps.rows !== null && caps.rows < SPRITE_FULL_ROWS + 8;
  const tooNarrow =
    caps.columns !== null && caps.columns < frameWidth(renderSpriteFull({ grid, palette, caps }));

  const compact = argv.includes('--compact') || tooShort || tooNarrow;
  const draw = (g: typeof grid): string =>
    compact
      ? renderSprite({ grid: g, palette, caps })
      : renderSpriteFull({ grid: g, palette, caps });

  const base = draw(grid);

  out('');

  // Piping `--animate` somewhere must produce one clean frame, not six frames of
  // escape soup, and a terminal too short to hold the sprite cannot be scrolled
  // back over.
  // Both dimensions come from the frame that was actually drawn, so the gate
  // cannot disagree with what is on screen. A frame that wraps is a frame the
  // cursor arithmetic cannot reason about, so refuse to animate rather than
  // redraw through the middle of the previous one.
  const drawnRows = base.split('\n').length;
  const drawnWidth = frameWidth(base);
  const canAnimate =
    argv.includes('--animate') &&
    caps.tier !== 'mono' &&
    Boolean(process.stdout.isTTY) &&
    (caps.rows === null || caps.rows >= drawnRows + 4) &&
    (caps.columns === null || caps.columns >= drawnWidth);

  if (canAnimate) {
    await blinkSprite(base, draw(blink(grid)), { rows: drawnRows });
  } else {
    out(base);
  }

  out('');
  out(
    renderIdentity({
      species: state.species,
      stage: state.stage,
      branch: state.branch,
      level: state.level,
      quip: freshQuip(),
    }),
  );
  out('');
}

// --- voice -----------------------------------------------------------------

function cmdVoice(argv: string[]): void {
  const config = readOrCreateConfig();
  const action = argv[0] ?? 'status';

  if (action === 'status') {
    out('');
    out(`  voice is ${config.voice ? 'on' : 'off'}`);
    // Silence is the right runtime behaviour for a missing backend and a
    // terrible diagnostic, so this is the one place that says so out loud.
    if (!voiceCommandFor('test', realVoiceEnv())) {
      out('  no speech backend on this machine — install speech-dispatcher (spd-say)');
    }
    out('');
    out('  speaks on: a level up, an evolution, a hard-won fix, and a fix made with an agent');
    out('  usage: familiar voice on|off|status');
    out('');
    return;
  }

  if (action === 'on' || action === 'off') {
    config.voice = action === 'on';
    writeConfig(config);
    out('');
    out(`  voice ${config.voice ? 'on' : 'off'}`);
    if (config.voice) {
      // A voice feature you cannot verify gets reported as broken.
      speakAloud('voice enabled');
      out('  you should have heard that. if not, try `familiar voice status`.');
    }
    out('');
    return;
  }

  out(`  unknown voice action "${action}". use on, off or status.`);
  process.exitCode = 1;
}

// --- shell -----------------------------------------------------------------

/**
 * Deliberately not part of `init`. Editing a shell profile is the most
 * invasive thing Familiar does, so you have to ask for it by name.
 */
function cmdShell(argv: string[]): void {
  const action = argv[0] ?? 'status';
  const requested = argv[1];

  // Naming a shell we do not know used to fall through to "all of them", so
  // `familiar shell install fish` quietly rewrote three unrelated profiles.
  if (requested && !(SHELLS as readonly string[]).includes(requested)) {
    out(`  unknown shell "${requested}". options: ${SHELLS.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const targets: ShellName[] = requested ? [requested as ShellName] : [...SHELLS];

  if (action === 'status') {
    out('');
    for (const shell of SHELLS) {
      const status = shellStatus(shell);
      out(`  ${SHELL_LABELS[shell].padEnd(11)} ${status.installed ? 'installed' : 'not installed'}`);
      out(`              ${status.profilePath}`);
      // "installed" only ever meant "the block is in the file". Saying so and
      // stopping there is what let this look healthy while doing nothing.
      if (status.installed && status.loadVerdict === 'blocked') {
        out(`              ⚠ cannot load — execution policy is ${status.policy}`);
      }
    }
    out('');
    out(`  usage: familiar shell install|uninstall [${SHELLS.join('|')}]`);
    out('');
    return;
  }

  if (action === 'install') {
    ensureHome();
    out('');
    let blocked: string | null = null;
    for (const shell of targets) {
      try {
        const result = installShell(shell);
        const verb = result.replaced ? 'updated' : result.created ? 'created' : 'added to';
        out(`  ${SHELL_LABELS[shell]}: ${verb} ${result.profilePath}`);
        if (result.backup) out(`              backup: ${result.backup}`);

        const status = shellStatus(shell);
        if (status.loadVerdict === 'blocked') blocked = status.policy;
      } catch (error) {
        logError(`shell:install:${shell}`, error);
        out(`  ${SHELL_LABELS[shell]}: failed — ${(error as Error).message}`);
      }
    }

    out('');
    if (blocked) {
      // The write succeeded and the file is correct — the machine simply will
      // not run it. Reporting plain success here is how most Windows users end
      // up with a security error on every shell launch and no feature at all.
      out(`  ⚠  your execution policy is ${blocked}, so PowerShell will refuse to load`);
      out('     this profile. You will see a security error on every new shell, and');
      out('     nothing will be counted until it is changed.');
      out('');
      out('     this usually fixes it, and needs no admin rights:');
      out(`       ${POLICY_FIX_COMMAND}`);
      out('');
      out('     (on a machine managed by group policy it may not apply — check with');
      out('      Get-ExecutionPolicy -List)');
    } else {
      out('  open a NEW shell for this to take effect.');
      out('  from then on, test/build/typecheck runs count wherever you run them.');
    }
    out('');
    return;
  }

  if (action === 'uninstall') {
    out('');
    for (const shell of targets) {
      try {
        const result = uninstallShell(shell);
        out(
          result.removed
            ? `  ${SHELL_LABELS[shell]}: removed from ${result.profilePath}`
            : `  ${SHELL_LABELS[shell]}: nothing to remove`,
        );
        if (result.backup) out(`              backup: ${result.backup}`);
      } catch (error) {
        logError(`shell:uninstall:${shell}`, error);
        out(`  ${SHELL_LABELS[shell]}: failed — ${(error as Error).message}`);
      }
    }
    out('');
    return;
  }

  out(`  unknown shell action "${action}". use install, uninstall or status.`);
  process.exitCode = 1;
}

// --- uninstall -------------------------------------------------------------

function cmdUninstall(): void {
  const result = uninstallClaudeIntegration();
  const config = readConfig();
  if (config) {
    config.claudeInstalled = false;
    writeConfig(config);
  }

  out('');
  out(`  removed ${result.hooksRemoved} hook(s)${result.statusLineRemoved ? ' and the statusline' : ''}`);
  if (result.backup) out(`  backup of the previous settings: ${result.backup}`);
  out(`  your event log is untouched at ${familiarHome()}`);
  out('');
}

// --- help ------------------------------------------------------------------

function cmdHelp(): void {
  out(`
  familiar — a companion that levels up on what you actually ship

    familiar init [--force] [--quiet]       seed a species, wire up Claude Code
                 [--no-claude]              (--quiet skips the questions)
    familiar status [--debug]               form, level, XP, habits, this week
    familiar look [--animate] [--compact]   draw the sprite in your terminal
    familiar show                           open the pixel-art widget
    familiar tone [name]                    ${TONES.join(' · ')}
    familiar colour [name]                  ${COLOURS.join(' · ')}
    familiar voice on|off|status            speak the big moments out loud
    familiar shell install|uninstall        count checks from your own terminal
    familiar uninstall                      remove hooks and statusline
    familiar where                          print state locations

  XP comes from outcomes — commits, merged PRs, and things you fixed.
  Running a tool is worth zero. So is a test that was already green:
  what counts is the moment it stopped being broken.
`);
}

function cmdWhere(): void {
  const config = readConfig();
  out('');
  out(`  state     ${familiarHome()}`);
  out(`  settings  ${claudeSettingsPath()}`);
  out(`  cli       ${cliEntrypoint()}`);
  out(`  wired     ${config?.claudeInstalled ? 'yes' : 'no'}`);
  out('');
}

// --- dispatch --------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? 'status';
  const rest = argv.slice(1);

  switch (command) {
    case 'hook':
      // Never allowed to throw or exit non-zero. See hook.ts.
      await runHook(argValue(rest, 'event') ?? 'Unknown');
      return;
    case 'statusline':
      cmdStatusline();
      return;
    case 'init':
      await cmdInit(rest);
      return;
    case 'status':
      cmdStatus(rest);
      return;
    case 'look':
      await cmdLook(rest);
      return;
    case 'show':
      await cmdShow();
      return;
    case 'tone':
      cmdTone(rest);
      return;
    case 'colour':
    case 'color':
      cmdColour(rest);
      return;
    case 'voice':
      cmdVoice(rest);
      return;
    case 'shell':
      cmdShell(rest);
      return;
    case 'uninstall':
      cmdUninstall();
      return;
    case 'where':
      cmdWhere();
      return;
    case 'help':
    case '--help':
    case '-h':
      cmdHelp();
      return;
    default:
      out(`  unknown command "${command}"`);
      cmdHelp();
      process.exitCode = 1;
  }
}

void main().catch((error) => {
  logError('cli', error);
  out(`  something went wrong: ${(error as Error).message}`);
  process.exitCode = 1;
});

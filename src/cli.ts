#!/usr/bin/env node
/**
 * The CLI — the doorway, not the creature.
 *
 * Every command that renders something also runs a cheap incremental git scan
 * first, which is why there is no `familiar refresh`: looking at your familiar
 * is what brings it up to date.
 */

import { homedir } from 'node:os';
import { dirname } from 'node:path';

import {
  commitDatesSince,
  configuredEmail,
  discoverRepos,
  findRepoRoot,
  headSha,
  scanAll,
} from './adapters/git.js';
import { formIdentity } from './core/forms.js';
import { profileRhythm, selectSpecies, SPECIES_BLURBS, SPECIES_LABELS } from './core/species.js';
import { TONES, TONE_LABELS, type ToneName } from './core/tone.js';
import { deriveState } from './core/xp.js';
import { drainShellLog } from './adapters/terminal.js';
import { runHook } from './hook.js';
import {
  installShell,
  shellStatus,
  SHELL_LABELS,
  SHELLS,
  uninstallShell,
  type ShellName,
} from './shell/install.js';
import { cliEntrypoint, installClaudeIntegration, uninstallClaudeIntegration } from './install.js';
import {
  defaultConfig,
  logError,
  readConfig,
  readOrCreateConfig,
  writeConfig,
  writeCursors,
  type CursorFile,
} from './state/config.js';
import { appendEvents, ensureHome, readEventsDetailed } from './state/log.js';
import { claudeSettingsPath, familiarHome } from './state/paths.js';
import { renderStatusCard } from './ui/status-card.js';
import { freshQuip, renderStatusline } from './ui/statusline.js';
import { startWidget } from './ui/web/server.js';

const SEED_WINDOW_DAYS = 60;

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

/**
 * Seeds a species from recent history.
 *
 * Reads *rhythm only* — how often and how evenly commits land — and never
 * awards a single point of XP. Per the design: history seeds personality, not
 * level. A creature that starts maxed has skipped the entire game.
 */
function seedSpecies(cwd: string): { species: ReturnType<typeof selectSpecies>; repos: string[]; commits: number } {
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

function cmdInit(argv: string[]): void {
  const force = argv.includes('--force');
  const skipClaude = argv.includes('--no-claude');
  const cwd = process.cwd();

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

  const config = existing ? { ...existing, species } : defaultConfig(species);
  config.repos = repos;
  writeConfig(config);

  // Pin every discovered repo to its current HEAD. This is what stops the
  // first real scan from replaying years of commits as XP.
  const cursors: CursorFile = {};
  const now = new Date().toISOString();
  for (const repo of repos) {
    cursors[repo] = { lastSha: headSha(repo), lastScan: now };
  }
  writeCursors(cursors);

  out(`  found ${commits} commits across ${repos.length} repo(s) in the last ${SEED_WINDOW_DAYS} days`);
  out('');
  out(`  🥚  your familiar is a ${SPECIES_LABELS[species]} egg`);
  out(`      ${SPECIES_BLURBS[species]}`);
  out('');
  out('  history seeded its personality, not its level — it starts at Lv.1 like everyone else.');
  out('');

  if (skipClaude) {
    out('  skipped Claude Code wiring (--no-claude)');
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
  } catch (error) {
    logError('init:install', error);
    out(`  could not wire into Claude Code: ${(error as Error).message}`);
    out('  everything else still works — the git adapter needs no setup.');
  }
  out('');
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
    out(renderStatusline({ events, species: config.species, quip: freshQuip() }));
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

// --- shell -----------------------------------------------------------------

/**
 * Deliberately not part of `init`. Editing a shell profile is the most
 * invasive thing Familiar does, so you have to ask for it by name.
 */
function cmdShell(argv: string[]): void {
  const action = argv[0] ?? 'status';
  const requested = argv[1];
  const targets: ShellName[] =
    requested && (SHELLS as readonly string[]).includes(requested)
      ? [requested as ShellName]
      : [...SHELLS];

  if (action === 'status') {
    out('');
    for (const shell of SHELLS) {
      const status = shellStatus(shell);
      out(`  ${SHELL_LABELS[shell].padEnd(11)} ${status.installed ? 'installed' : 'not installed'}`);
      out(`              ${status.profilePath}`);
    }
    out('');
    out('  usage: familiar shell install|uninstall [powershell|bash]');
    out('');
    return;
  }

  if (action === 'install') {
    ensureHome();
    out('');
    for (const shell of targets) {
      try {
        const result = installShell(shell);
        const verb = result.replaced ? 'updated' : result.created ? 'created' : 'added to';
        out(`  ${SHELL_LABELS[shell]}: ${verb} ${result.profilePath}`);
        if (result.backup) out(`              backup: ${result.backup}`);
      } catch (error) {
        logError(`shell:install:${shell}`, error);
        out(`  ${SHELL_LABELS[shell]}: failed — ${(error as Error).message}`);
      }
    }
    out('');
    out('  open a NEW shell for this to take effect.');
    out('  from then on, test/build/typecheck runs count wherever you run them.');
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

    familiar init [--force] [--no-claude]   seed a species, wire up Claude Code
    familiar status [--debug]               form, level, XP, habits, this week
    familiar show                           open the pixel-art widget
    familiar tone [name]                    ${TONES.join(' · ')}
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
      cmdInit(rest);
      return;
    case 'status':
      cmdStatus(rest);
      return;
    case 'show':
      await cmdShow();
      return;
    case 'tone':
      cmdTone(rest);
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

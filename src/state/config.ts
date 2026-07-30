/**
 * Settings, scan cursors, the statusline render cache, and the error log.
 *
 * Everything in here is disposable. Deleting any of it costs you preferences or
 * makes the next git scan slower — it never costs history, which lives only in
 * events.jsonl.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

import { SPECIES, type Species } from '../core/species.js';
import { TONES, type ToneName } from '../core/tone.js';
import { configPath, cursorPath, errorLogPath, renderCachePath } from './paths.js';
import { ensureHome } from './log.js';

export const CONFIG_VERSION = 1;

export interface FamiliarConfig {
  version: number;
  species: Species;
  tone: ToneName;
  createdAt: string;
  /** Absolute paths of every git repo Familiar has seen. Discovered passively. */
  repos: string[];
  /** Whether `init` wired up Claude Code. */
  claudeInstalled: boolean;
}

export function defaultConfig(species: Species = 'sprout'): FamiliarConfig {
  return {
    version: CONFIG_VERSION,
    species,
    tone: 'deadpan',
    createdAt: new Date().toISOString(),
    repos: [],
    claudeInstalled: false,
  };
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    // Tolerate a UTF-8 BOM — see the note in install.ts.
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as T;
  } catch {
    return null;
  }
}

function writeJson(path: string, value: unknown): void {
  ensureHome();
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/** Returns null when Familiar has not been initialised. Callers decide what that means. */
export function readConfig(): FamiliarConfig | null {
  const raw = readJson<Partial<FamiliarConfig>>(configPath());
  if (!raw) return null;

  const species: Species =
    raw.species && (SPECIES as readonly string[]).includes(raw.species) ? raw.species : 'sprout';
  const tone: ToneName =
    raw.tone && (TONES as readonly string[]).includes(raw.tone) ? raw.tone : 'deadpan';

  return {
    version: typeof raw.version === 'number' ? raw.version : CONFIG_VERSION,
    species,
    tone,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    repos: Array.isArray(raw.repos) ? raw.repos.filter((r): r is string => typeof r === 'string') : [],
    claudeInstalled: raw.claudeInstalled === true,
  };
}

export function writeConfig(config: FamiliarConfig): void {
  writeJson(configPath(), config);
}

/** Reads config, or creates a default one. Used by surfaces that must not fail. */
export function readOrCreateConfig(): FamiliarConfig {
  const existing = readConfig();
  if (existing) return existing;
  const created = defaultConfig();
  writeConfig(created);
  return created;
}

/** Adds a repo to the registry if it is new. Returns true when something changed. */
export function registerRepo(repoPath: string): boolean {
  const config = readOrCreateConfig();
  if (config.repos.includes(repoPath)) return false;
  config.repos.push(repoPath);
  writeConfig(config);
  return true;
}

// --- scan cursors ----------------------------------------------------------

export interface RepoCursor {
  lastSha: string | null;
  lastScan: string;
}

export type CursorFile = Record<string, RepoCursor>;

export function readCursors(): CursorFile {
  return readJson<CursorFile>(cursorPath()) ?? {};
}

export function writeCursors(cursors: CursorFile): void {
  writeJson(cursorPath(), cursors);
}

// --- statusline render cache ----------------------------------------------

/**
 * The last thing the familiar said, and when.
 *
 * Written by hooks (which know what just happened) and only ever *read* by the
 * statusline. That split exists because Claude Code kills an in-flight
 * statusline script when a new update arrives, so the statusline must never be
 * mid-write of anything. It also gives the voice its cooldown for free.
 */
export interface RenderCache {
  quip: string;
  updatedAt: string;
}

export function readRenderCache(): RenderCache | null {
  return readJson<RenderCache>(renderCachePath());
}

export function writeRenderCache(quip: string): void {
  writeJson(renderCachePath(), { quip, updatedAt: new Date().toISOString() } satisfies RenderCache);
}

// --- error log -------------------------------------------------------------

/**
 * Where a hook's swallowed failures go. Best-effort by definition: if we cannot
 * even write the error log, there is nothing useful left to do but continue.
 */
export function logError(context: string, error: unknown): void {
  try {
    ensureHome();
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    appendFileSync(errorLogPath(), `[${new Date().toISOString()}] ${context}: ${message}\n`, 'utf8');
  } catch {
    /* nothing left to do */
  }
}

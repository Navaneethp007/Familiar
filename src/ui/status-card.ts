/**
 * `familiar status` — the on-demand text card.
 */

import { formIdentity } from '../core/forms.js';
import { BRANCH_LABELS, type HabitScores } from '../core/habits.js';
import { SPECIES_BLURBS, SPECIES_LABELS } from '../core/species.js';
import { TONE_LABELS, type ToneName } from '../core/tone.js';
import { weeklyTotals, type CreatureState } from '../core/xp.js';
import type { FamiliarEvent } from '../core/events.js';

export function bar(progress: number, width = 20, filled = '█', empty = '░'): string {
  // NaN would slip through Math.min/max and make repeat() produce an empty
  // string, silently collapsing the layout. Treat unusable input as zero.
  const safe = Number.isFinite(progress) ? progress : 0;
  const on = Math.round(Math.min(1, Math.max(0, safe)) * width);
  return filled.repeat(on) + empty.repeat(Math.max(0, width - on));
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`.padStart(4);
}

function habitLines(habits: HabitScores, branch: string | null): string[] {
  const rows: Array<[string, number, string]> = [
    ['🦉 night owl    ', habits.night, 'night_owl'],
    ['🧪 test guardian', habits.test, 'test_guardian'],
    ['⚡ speed demon  ', habits.speed, 'speed_demon'],
    ['🔥 firefighter  ', habits.firefighter, 'firefighter'],
    ['🛠️  refactorer   ', habits.refactorer, 'refactorer'],
    ['🎯 one-shot     ', habits.oneShot, 'one_shot'],
    ['🪄 conjurer     ', habits.conjurer, 'conjurer'],
  ];
  return rows.map(([label, value, key]) => {
    const marker = branch === key ? ' ←' : '';
    return `  ${label} ${bar(value, 16)} ${pct(value)}${marker}`;
  });
}

export interface StatusCardInput {
  state: CreatureState;
  events: readonly FamiliarEvent[];
  tone: ToneName;
  /** Shown only when on — an off switch nobody flipped is not news. */
  voice?: boolean;
  quip?: string;
  skippedLines?: number;
  now?: Date;
}

export function renderStatusCard(input: StatusCardInput): string {
  const { state, events, tone, voice = false, quip, skippedLines = 0 } = input;
  const now = input.now ?? new Date();
  const form = formIdentity(state.species, state.stage, state.branch);
  const week = weeklyTotals(events, now);

  const lines: string[] = [];

  lines.push('');
  lines.push(`  ${form.emoji}  ${form.name}  ·  Lv.${state.level}`);
  lines.push(
    `      ${SPECIES_LABELS[state.species]} — ${SPECIES_BLURBS[state.species]}`,
  );
  if (state.branch) {
    lines.push(`      evolved: ${BRANCH_LABELS[state.branch]}`);
  }
  lines.push('');

  if (state.nextLevelAt === null) {
    lines.push(`  XP  ${bar(1)}  ${state.xp} (max level)`);
  } else {
    const into = state.xp - state.levelFloor;
    const span = state.nextLevelAt - state.levelFloor;
    lines.push(
      `  XP  ${bar(state.progress)}  ${into}/${span}  ·  ${state.nextLevelAt - state.xp} to Lv.${state.level + 1}`,
    );
  }
  lines.push('');

  lines.push('  habits');
  lines.push(...habitLines(state.habits, state.branch));
  lines.push('');

  lines.push('  this week');
  lines.push(`    ${week.commit} commits · ${week.pr_merged} merged`);
  lines.push('');

  const { checks } = state;
  lines.push('  checks');
  lines.push(
    `    ${checks.fixes} fixed · ${checks.firstGreens} clean pass · ${checks.failures} red` +
      (checks.fixesWithAgent > 0 ? ` · ${checks.fixesWithAgent} with an agent` : ''),
  );
  if (checks.fixes === 0 && checks.failures === 0) {
    // Otherwise a row of zeroes looks like a bug rather than a missing adapter.
    lines.push('    (nothing is reporting check outcomes — try `familiar shell install`)');
  }
  lines.push('');

  lines.push(
    `  all time  ${state.totals.commit} commits · ${state.totals.pr_merged} merged · ${state.eventCount} events`,
  );
  lines.push(`  tone      ${TONE_LABELS[tone]}`);
  if (voice) lines.push('  voice     on');

  if (quip) {
    lines.push('');
    lines.push(`  "${quip}"`);
  }

  if (skippedLines > 0) {
    lines.push('');
    lines.push(`  note: ${skippedLines} unreadable line(s) in the event log were skipped`);
  }

  lines.push('');
  return lines.join('\n');
}

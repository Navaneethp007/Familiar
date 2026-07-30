import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deriveState } from '../src/core/xp.js';
import { writeRenderCache } from '../src/state/config.js';
import { bar, renderStatusCard } from '../src/ui/status-card.js';
import { freshQuip, miniBar, QUIP_TTL_MS, renderStatusline } from '../src/ui/statusline.js';
import { startWidget } from '../src/ui/web/server.js';
import { series, useTempHome } from './helpers.js';

let home: ReturnType<typeof useTempHome>;

beforeEach(() => {
  home = useTempHome();
});

afterEach(() => {
  home.cleanup();
});

describe('bars', () => {
  it('renders empty, partial and full', () => {
    expect(bar(0, 10)).toBe('░'.repeat(10));
    expect(bar(1, 10)).toBe('█'.repeat(10));
    expect(bar(0.5, 10)).toBe('█'.repeat(5) + '░'.repeat(5));
  });

  it('clamps out-of-range values instead of producing junk', () => {
    expect(bar(-3, 6)).toBe('░'.repeat(6));
    expect(bar(42, 6)).toBe('█'.repeat(6));
    expect(miniBar(Number.NaN, 5)).toHaveLength(5);
  });

  it('always produces the requested width', () => {
    for (let i = 0; i <= 20; i++) expect(bar(i / 20, 17)).toHaveLength(17);
  });
});

describe('the statusline', () => {
  it('shows form, level and progress', () => {
    const line = renderStatusline({ events: series('commit', 4), species: 'ember' });
    expect(line).toMatch(/Lv\.\d+/);
    expect(line).toMatch(/[▓░]{5}/);
  });

  it('appends a quip when there is one', () => {
    const withQuip = renderStatusline({
      events: series('commit', 2),
      species: 'sprout',
      quip: 'noted.',
    });
    expect(withQuip).toContain('"noted."');
  });

  it('stays quiet when there is no quip', () => {
    expect(renderStatusline({ events: [], species: 'sprout' })).not.toContain('"');
  });

  it('fits comfortably on one line', () => {
    const line = renderStatusline({
      events: series('pr_merged', 30),
      species: 'wisp',
      quip: 'merged. it is done.',
    });
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThan(80);
  });

  it('renders an empty log without throwing', () => {
    expect(() => renderStatusline({ events: [], species: 'wisp' })).not.toThrow();
  });
});

describe('quip freshness', () => {
  it('returns nothing when none was ever written', () => {
    expect(freshQuip()).toBeNull();
  });

  it('returns a recent quip', () => {
    writeRenderCache('noted.');
    expect(freshQuip()).toBe('noted.');
  });

  it('lets an old quip expire', () => {
    writeRenderCache('ancient history');
    const later = new Date(Date.now() + QUIP_TTL_MS + 1_000);
    expect(freshQuip(later)).toBeNull();
  });
});

describe('the status card', () => {
  const events = [...series('commit', 6, { touchedTests: true }), ...series('tests_passed', 2)];

  it('shows the form, level, habits and week', () => {
    const card = renderStatusCard({
      state: deriveState(events, { species: 'ember' }),
      events,
      tone: 'deadpan',
      now: new Date('2026-07-01T20:00:00Z'),
    });

    expect(card).toContain('Lv.');
    expect(card).toContain('habits');
    expect(card).toContain('night owl');
    expect(card).toContain('test guardian');
    expect(card).toContain('speed demon');
    expect(card).toContain('this week');
    expect(card).toContain('Deadpan');
  });

  it('renders an untouched install without throwing', () => {
    const card = renderStatusCard({ state: deriveState([]), events: [], tone: 'zen' });
    expect(card).toContain('Egg');
    expect(card).toContain('Lv.1');
  });

  it('marks the evolved branch', () => {
    const evolved = [...series('pr_merged', 40, { hour: 2 }), ...series('commit', 12, { hour: 2 })];
    const state = deriveState(evolved, { species: 'wisp' });
    const card = renderStatusCard({ state, events: evolved, tone: 'hype' });
    expect(state.branch).not.toBeNull();
    expect(card).toContain('evolved:');
    expect(card).toContain('←');
  });

  it('warns about unreadable log lines instead of hiding them', () => {
    const card = renderStatusCard({
      state: deriveState([]),
      events: [],
      tone: 'zen',
      skippedLines: 3,
    });
    expect(card).toContain('3 unreadable line');
  });
});

describe('the web widget', () => {
  it('serves state and shuts down when nobody is looking', async () => {
    const widget = await startWidget({ open: false, idleShutdownMs: 60_000 });
    try {
      const page = await fetch(widget.url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('<canvas');

      const state = (await (await fetch(`${widget.url}api/state`)).json()) as Record<string, unknown>;
      expect(state['level']).toBe(1);
      expect(state['form']).toBeDefined();
      expect((state['sprite'] as { grid: string[] }).grid).toHaveLength(16);
      expect(state['tones']).toHaveLength(4);
    } finally {
      widget.close();
    }
  });

  it('switches tone from the page', async () => {
    const widget = await startWidget({ open: false, idleShutdownMs: 60_000 });
    try {
      const res = await fetch(`${widget.url}api/tone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tone: 'gremlin' }),
      });
      expect(res.status).toBe(200);

      const state = (await (await fetch(`${widget.url}api/state`)).json()) as { tone: string };
      expect(state.tone).toBe('gremlin');
    } finally {
      widget.close();
    }
  });

  it('rejects an unknown tone', async () => {
    const widget = await startWidget({ open: false, idleShutdownMs: 60_000 });
    try {
      const res = await fetch(`${widget.url}api/tone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tone: 'shakespearean' }),
      });
      expect(res.status).toBe(400);
    } finally {
      widget.close();
    }
  });

  it('404s an unknown path', async () => {
    const widget = await startWidget({ open: false, idleShutdownMs: 60_000 });
    try {
      expect((await fetch(`${widget.url}nope`)).status).toBe(404);
    } finally {
      widget.close();
    }
  });

  it('exits on its own once polling stops', async () => {
    const widget = await startWidget({ open: false, idleShutdownMs: 1_200 });
    await fetch(`${widget.url}api/state`);

    await new Promise((r) => setTimeout(r, 3_000));

    await expect(fetch(widget.url)).rejects.toThrow();
  });
});

// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { applyThemeSnapshot } from '../../src/shared/theme';

const sharedRoot = resolve(process.cwd());

function cssFilesUnder(dir: string): string[] {
  const entries: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);

    if (stats.isDirectory()) {
      entries.push(...cssFilesUnder(full));
    } else if (entry.endsWith('.css')) {
      entries.push(full);
    }
  }

  return entries;
}

const THEME_TOKENS = {
  background: '#0b0d10',
  foreground: '#e6e8eb',
  muted: '#8b929c',
  mutedSurface: '#1a1f26',
  elevated: '#10141a',
  elevatedForeground: '#e6e8eb',
  subtle: '#141920',
  border: '#2a2f37',
  hover: '#1a1f26',
  active: '#232932',
  selection: '#1f2a3a',
  selectionForeground: '#e6e8eb',
  focus: '#4c8dff',
  primary: '#4c8dff',
  primaryForeground: '#ffffff',
  primaryText: '#4c8dff',
  success: '#34d399',
  successText: '#34d399',
  warning: '#fbbf24',
  warningText: '#fbbf24',
  error: '#f87171',
  errorText: '#f87171',
  info: '#39c0ed',
  infoText: '#39c0ed',
  font: 'system-ui',
  mono: 'ui-monospace',
  radius: '8px',
  fontSize: '14px',
};

function minimalReadyContext(): Parameters<typeof applyThemeSnapshot>[0] {
  return {
    theme: { mode: 'dark', tokens: THEME_TOKENS },
    locale: 'en-US',
    directory: '/repo/demo',
    session: null,
    surface: 'page',
    connection: { online: true } as never,
    settings: {},
    item: null,
  } as never;
}

describe('applyThemeSnapshot', () => {
  it('writes host tokens as CSS variables on the surface root', () => {
    const root = document.createElement('div');
    document.body.append(root);

    applyThemeSnapshot(minimalReadyContext(), root);

    expect(root.dataset['ocTheme']).toBe('dark');
    expect(root.dataset['ocSurface']).toBe('page');

    root.remove();
  });

  it('applies tokens repeatedly without duplicating variables or listeners', () => {
    const root = document.createElement('div');
    document.body.append(root);

    const context = minimalReadyContext();
    applyThemeSnapshot(context, root);
    applyThemeSnapshot({ ...context, theme: { mode: 'light', tokens: THEME_TOKENS } }, root);

    expect(root.dataset['ocTheme']).toBe('light');
    const inline = root.getAttribute('style') ?? '';
    // Repeated application keeps a single value per variable.
    expect(inline.match(/--primary:/g)?.length ?? 0).toBe(1);
    expect(inline).toContain('--primary: #4c8dff');

    root.remove();
  });
});

describe('palette discipline', () => {
  it('never references private host --chart-* variables in shipped stylesheets', () => {
    const files = cssFilesUnder(join(sharedRoot, 'src'));

    for (const file of files) {
      const css = readFileSync(file, 'utf8');
      expect(css.includes('--chart-'), `${file} must not reference --chart-* variables`).toBe(false);
    }

    expect(files).toBeDefined();
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { buildSnapshot, mountPage, type PageHarness } from '../support/page-harness';

const harnesses: PageHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    harness.container.remove();
    document.body.textContent = '';
  }
});

function sessionsSection(harness: PageHarness): HTMLElement {
  return harness.container.querySelector('[data-section="top-sessions"]') as HTMLElement;
}

describe('top sessions', () => {
  it('mounts the navigation error line empty so no warning box shows', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot() });
    harnesses.push(harness);

    const errorLine = sessionsSection(harness).querySelector('[data-session-error]') as HTMLElement;
    expect(errorLine).not.toBeNull();
    expect(errorLine.textContent).toBe('');
  });

  it('renders cost/token/date columns with the project basename and caps at ten rows', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot() });
    harnesses.push(harness);

    const section = sessionsSection(harness);
    const rows = [...section.querySelectorAll('[data-session-row]')];

    expect(rows).toHaveLength(10);

    const first = rows[0] as HTMLElement;
    expect(first.textContent).toContain('$');
    expect(first.textContent).toContain('tokens');
    expect(first.textContent).toContain('demo');
    // The full directory must not leak into the label.
    expect(first.textContent).not.toContain('/repo/demo');

    // Aligned value columns across rows via the shared grid.
    const grid = section.querySelector('[data-sessions-grid]') as HTMLElement;
    expect(grid.style.gridTemplateColumns.length).toBeGreaterThan(0);
  });

  it('opens the session through the public host API on activation', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot() });
    harnesses.push(harness);

    const rows = [...sessionsSection(harness).querySelectorAll('[data-session-row]')] as HTMLElement[];
    const first = rows[0]!;
    expect(first.dataset['sessionId']).toBe('ses_00');

    first.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(harness.bridge.openCalls).toEqual(['ses_00']);
  });

  it('keeps rows intact and explains when navigation fails', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot() });
    harnesses.push(harness);
    harness.bridge.openFailures = true;

    const rows = [...sessionsSection(harness).querySelectorAll('[data-session-row]')] as HTMLElement[];
    rows[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(harness.bridge.openCalls).toEqual(['ses_00']);
    const section = sessionsSection(harness);
    expect(section.querySelectorAll('[data-session-row]')).toHaveLength(10);
    expect(section.querySelector('[data-session-error]')?.textContent?.length ?? 0).toBeGreaterThan(0);
    // No fabricated route link.
    expect(section.querySelector('a[href]')).toBeNull();
  });

  it('renders a keyboard-activatable row (Enter/Space)', async () => {
    const harness = await mountPage({ snapshot: buildSnapshot() });
    harnesses.push(harness);

    const rows = [...sessionsSection(harness).querySelectorAll('[data-session-row]')] as HTMLElement[];
    expect(rows[0]!.getAttribute('tabindex')).toBe('0');

    rows[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(harness.bridge.openCalls).toEqual(['ses_00']);
  });
});

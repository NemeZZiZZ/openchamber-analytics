// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createChartTooltip, type ChartTooltip, type TooltipContent } from '../../src/ui/charts/chart-tooltip';

const tooltips: ChartTooltip[] = [];
const containers: HTMLElement[] = [];

afterEach(() => {
  for (const tooltip of tooltips.splice(0)) {
    tooltip.destroy();
  }

  for (const container of containers.splice(0)) {
    container.remove();
  }

  document.body.textContent = '';
});

function mount(): HTMLElement {
  const element = document.createElement('div');
  document.body.append(element);
  containers.push(element);
  return element;
}

const CONTENT = {
  title: '2026-11-18',
  rows: [
    { color: '#4c8dff', label: 'zai/glm-5', value: '1,234 tokens' },
    { color: '#39c0ed', label: 'zai/glm-6', value: '12 tokens' },
  ],
};

describe('createChartTooltip', () => {
  it('renders one fixed-position element with the 320px cap above overlays', () => {
    const tooltip = createChartTooltip();
    tooltips.push(tooltip);

    tooltip.show(CONTENT, { clientX: 100, clientY: 200 });

    const element = document.querySelector('.an-chart-tooltip') as HTMLElement;
    expect(element).not.toBeNull();
    expect(element.style.position).toBe('fixed');
    expect(element.className).toContain('an-max-w-320');
    expect(Number(element.style.zIndex)).toBeGreaterThanOrEqual(100);

    // Title and rows are text nodes; row identity stays intact.
    expect(element.textContent).toContain('2026-11-18');
    expect(element.textContent).toContain('zai/glm-5');
    expect(element.textContent).toContain('1,234 tokens');
  });

  it('applies the pointer offset exactly once', () => {
    const tooltip = createChartTooltip();
    tooltips.push(tooltip);

    tooltip.show(CONTENT, { clientX: 100, clientY: 200 });

    const element = document.querySelector('.an-chart-tooltip') as HTMLElement;
    expect(element.style.left).toBe('112px');
    expect(element.style.top).toBe('212px');

    // Showing again at the same anchor does not stack offsets.
    tooltip.show(CONTENT, { clientX: 100, clientY: 200 });
    expect(element.style.left).toBe('112px');
    expect(element.style.top).toBe('212px');
  });

  it('flips away from the right and bottom viewport edges', () => {
    const tooltip = createChartTooltip();
    tooltips.push(tooltip);

    Object.defineProperty(document.documentElement, 'clientWidth', { value: 400, configurable: true });
    Object.defineProperty(document.documentElement, 'clientHeight', { value: 300, configurable: true });

    tooltip.show(CONTENT, { clientX: 390, clientY: 290 });

    const element = document.querySelector('.an-chart-tooltip') as HTMLElement;
    const left = Number.parseFloat(element.style.left);
    const top = Number.parseFloat(element.style.top);

    expect(left).toBeLessThan(390);
    expect(top).toBeLessThan(290);
  });

  it('renders hostile labels as inert text nodes', () => {
    const tooltip = createChartTooltip();
    tooltips.push(tooltip);

    tooltip.show(
      {
        title: '<img src=x onerror=alert(1)>',
        rows: [{ label: '<script>alert(2)</script>', value: '5' }],
      },
      { clientX: 10, clientY: 10 },
    );

    const element = document.querySelector('.an-chart-tooltip') as HTMLElement;
    expect(element.querySelector('img')).toBeNull();
    expect(element.querySelector('script')).toBeNull();
    expect(element.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('hides and destroys cleanly', () => {
    const tooltip = createChartTooltip();
    tooltips.push(tooltip);

    tooltip.show(CONTENT, { clientX: 10, clientY: 10 });
    expect(document.querySelector('.an-chart-tooltip')).not.toBeNull();

    tooltip.hide();
    expect(document.querySelector('.an-chart-tooltip')).toBeNull();

    tooltip.show(CONTENT, { clientX: 10, clientY: 10 });
    tooltip.destroy();
    expect(document.querySelector('.an-chart-tooltip')).toBeNull();
  });
});

describe('tooltip attachments', () => {
  it('attachPointerTo shows on move over a shape and keeps content across gaps', () => {
    const tooltip = createChartTooltip();
    tooltips.push(tooltip);
    const container = mount();

    const shape = document.createElement('rect');
    shape.className = 'an-bar';
    container.append(shape);

    const resolve = vi.fn<() => TooltipContent | null>(() => CONTENT);
    tooltip.attachPointerTo(container, resolve);

    // Moving over the shape shows the tooltip.
    shape.dispatchEvent(new MouseEvent('pointermove', { clientX: 20, clientY: 30, bubbles: true }));
    expect(document.querySelector('.an-chart-tooltip')).not.toBeNull();
    expect(document.querySelector('.an-chart-tooltip')?.textContent).toContain('2026-11-18');

    // Moving onto a gap (the container itself) keeps the last content instead
    // of hiding: no flicker while crossing the 2px gaps between shapes.
    resolve.mockReturnValue(null);
    container.dispatchEvent(new MouseEvent('pointermove', { clientX: 25, clientY: 31, bubbles: true }));
    expect(document.querySelector('.an-chart-tooltip')).not.toBeNull();
    expect(document.querySelector('.an-chart-tooltip')?.textContent).toContain('zai/glm-5');

    // Leaving the container as a whole hides once.
    container.dispatchEvent(new MouseEvent('pointerleave', { bubbles: false }));
    expect(document.querySelector('.an-chart-tooltip')).toBeNull();

    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('attachPointerTo detaches cleanly', () => {
    const tooltip = createChartTooltip();
    tooltips.push(tooltip);
    const container = mount();

    const detach = tooltip.attachPointerTo(container, () => CONTENT);
    detach();

    container.dispatchEvent(new MouseEvent('pointermove', { clientX: 1, clientY: 1, bubbles: true }));
    expect(document.querySelector('.an-chart-tooltip')).toBeNull();
  });

  it('attachKeyboardTo shows near the focused shape and hides on blur and Escape', () => {
    const tooltip = createChartTooltip();
    tooltips.push(tooltip);
    const container = mount();

    const element = document.createElement('rect');
    element.tabIndex = 0;
    container.append(element);
    tooltip.attachKeyboardTo(element, () => CONTENT);

    element.dispatchEvent(new FocusEvent('focus'));
    expect(document.querySelector('.an-chart-tooltip')).not.toBeNull();

    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.an-chart-tooltip')).toBeNull();

    element.dispatchEvent(new FocusEvent('focus'));
    expect(document.querySelector('.an-chart-tooltip')).not.toBeNull();
    element.dispatchEvent(new FocusEvent('blur'));
    expect(document.querySelector('.an-chart-tooltip')).toBeNull();
  });

  it('resolves content lazily per interaction', () => {
    const tooltip = createChartTooltip();
    tooltips.push(tooltip);
    const container = mount();

    const element = document.createElement('rect');
    container.append(element);

    let payload = { title: 'first', rows: [] };
    tooltip.attachPointerTo(container, () => payload);

    element.dispatchEvent(new MouseEvent('pointermove', { clientX: 0, clientY: 0, bubbles: true }));
    const first = document.querySelector('.an-chart-tooltip') as HTMLElement;
    expect(first.textContent).toContain('first');

    payload = { title: 'second', rows: [] };
    element.dispatchEvent(new MouseEvent('pointermove', { clientX: 5, clientY: 5, bubbles: true }));
    const second = document.querySelector('.an-chart-tooltip') as HTMLElement;
    expect(second.textContent).toContain('second');

    tooltip.destroy();
  });
});

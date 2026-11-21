// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { observeContainerWidth } from '../../src/ui/resize-observer';
import { createChartShell, scrollToLatest } from '../../src/ui/charts/chart-shell';

type MockResizeObserver = {
  callback: ResizeObserverCallback;
  element: Element;
  disconnect: () => void;
  observe: (element: Element) => void;
  trigger(width: number): void;
};

const observers: MockResizeObserver[] = [];
const originalObserver = globalThis.ResizeObserver;

class FakeResizeObserver {
  instances: MockResizeObserver[] = [];

  constructor(callback: ResizeObserverCallback) {
    const record: MockResizeObserver = {
      callback,
      element: null as unknown as Element,
      disconnect: vi.fn((): void => undefined),
      observe: vi.fn((element: Element): void => {
        record.element = element;
      }),
      trigger: (width: number) => {
        record.callback(
          [
            {
              target: record.element,
              contentRect: { width, height: 0, x: 0, y: 0, top: 0, left: 0, bottom: 0, right: 0, toJSON: () => undefined },
            } as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        );
      },
    };

    observers.push(record);
  }

  observe(element: Element): void {
    observers.at(-1)?.observe(element);
  }

  unobserve(): void {
    return;
  }

  disconnect(): void {
    observers.at(-1)?.disconnect();
  }
}

function installObserver(): void {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
}

afterEach(() => {
  observers.length = 0;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalObserver;
});

describe('observeContainerWidth', () => {
  it('fires the initial width and every width change, then disconnects', () => {
    installObserver();
    const element = document.createElement('div');
    Object.defineProperty(element, 'clientWidth', { value: 0, configurable: true });
    document.body.append(element);

    const widths: number[] = [];
    const stop = observeContainerWidth(element, (width) => widths.push(width));

    expect(widths).toEqual([0]);

    Object.defineProperty(element, 'clientWidth', { value: 320, configurable: true });
    observers[0]?.trigger(320);
    expect(widths).toEqual([0, 320]);

    // Width-only updates redraw; a same-width notification does not double-fire.
    observers[0]?.trigger(320);
    expect(widths).toEqual([0, 320]);

    stop();
    expect(observers[0]?.disconnect).toHaveBeenCalled();

    Object.defineProperty(element, 'clientWidth', { value: 480, configurable: true });
    observers[0]?.trigger(480);
    expect(widths).toEqual([0, 320]);

    element.remove();
  });
});

describe('createChartShell', () => {
  it('does not render invalid SVG at zero width and redraws on width updates', () => {
    installObserver();
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 0, configurable: true });
    document.body.append(container);

    const widths: number[] = [];
    const shell = createChartShell(container, {
      render: (width) => {
        widths.push(width);
      },
      minWidth: 40,
    });

    expect(widths).toEqual([]);

    Object.defineProperty(container, 'clientWidth', { value: 280, configurable: true });
    observers.at(-1)?.trigger(280);
    expect(widths).toEqual([280]);

    // A small shrink below minWidth clears the shell instead of clipping;
    // the renderer is never asked to draw a clipped chart.
    Object.defineProperty(container, 'clientWidth', { value: 10, configurable: true });
    observers.at(-1)?.trigger(10);
    expect(widths).toEqual([280]);
    expect(container.textContent).toContain('Too narrow');

    shell.destroy();
    expect(observers.at(-1)?.disconnect).toHaveBeenCalled();

    Object.defineProperty(container, 'clientWidth', { value: 500, configurable: true });
    observers.at(-1)?.trigger(500);
    expect(widths).not.toContain(500);

    container.remove();
  });
});

describe('scrollToLatest', () => {
  it('scrolls the year grid to its most recent end', () => {
    const scroller = document.createElement('div');

    Object.defineProperty(scroller, 'scrollWidth', { value: 1200, configurable: true });
    Object.defineProperty(scroller, 'clientWidth', { value: 400, configurable: true });
    Object.defineProperty(scroller, 'scrollLeft', { value: 0, writable: true, configurable: true });

    scrollToLatest(scroller);
    expect(scroller.scrollLeft).toBe(1200);
  });

  it('is a no-op for non-scrollable content', () => {
    const scroller = document.createElement('div');

    Object.defineProperty(scroller, 'scrollWidth', { value: 100, configurable: true });
    Object.defineProperty(scroller, 'clientWidth', { value: 100, configurable: true });
    Object.defineProperty(scroller, 'scrollLeft', { value: 0, writable: true, configurable: true });

    scrollToLatest(scroller);
    expect(scroller.scrollLeft).toBe(0);
  });
});

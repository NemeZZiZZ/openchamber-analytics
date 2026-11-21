// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { attachTimeSeriesBrush, type BrushHandle } from '../../src/ui/charts/time-series-brush';

const containers: HTMLElement[] = [];
const handles: BrushHandle[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.destroy();
  }

  for (const container of containers.splice(0)) {
    container.remove();
  }
});

function mount(): HTMLElement {
  const element = document.createElement('div');
  Object.defineProperty(element, 'clientWidth', { value: 300, configurable: true });
  document.body.append(element);
  containers.push(element);
  return element;
}

function fire(element: Element, type: string, init: Record<string, number> = {}): void {
  const event = new MouseEvent(type, { bubbles: true, ...init });
  Object.defineProperty(event, 'clientX', { value: init.clientX ?? 0 });
  element.dispatchEvent(event);
}

describe('attachTimeSeriesBrush — visibility and initial selection', () => {
  it('stays hidden at 30 buckets and appears at 31', () => {
    const container = mount();
    handles.push(attachTimeSeriesBrush({ container, count: 30, width: 300, identity: '30d' }));
    expect(container.querySelector('[data-brush-overview]')).toBeNull();

    handles.push(attachTimeSeriesBrush({ container, count: 31, width: 300, identity: '30d' }));
    expect(container.querySelectorAll('[data-brush-overview]').length).toBeGreaterThanOrEqual(1);
  });

  it('starts with the latest 30 buckets selected', () => {
    const container = mount();
    const handle = attachTimeSeriesBrush({ container, count: 90, width: 300, identity: '30d' });
    handles.push(handle);

    expect(handle.getSelection()).toEqual({ start: 60, end: 89 });

    const region = container.querySelector('[data-brush-selection]') as HTMLElement;
    expect(region.style.left).toBe(`${(((60 / 89) * 100)).toFixed(2)}%`);
    expect(Number.parseFloat(region.style.width)).toBeCloseTo(((29 / 89) * 100), 1);
  });

  it('uses an actual 32px overview with visible region and handles', () => {
    const container = mount();
    const handle = attachTimeSeriesBrush({ container, count: 90, width: 300, identity: '30d' });
    handles.push(handle);

    const overview = container.querySelector('[data-brush-overview]') as HTMLElement;
    expect(overview.dataset['brushOverviewHeight']).toBe('32');
    expect(overview.style.height).toBe('32px');

    const region = container.querySelector('[data-brush-selection]') as HTMLElement;
    expect(region).not.toBeNull();

    const startHandle = container.querySelector('[data-brush-handle="start"]') as HTMLElement;
    const endHandle = container.querySelector('[data-brush-handle="end"]') as HTMLElement;
    expect(startHandle.getAttribute('role')).toBe('slider');
    expect(endHandle.getAttribute('role')).toBe('slider');
    expect(startHandle.getAttribute('tabindex')).toBe('0');
    expect(startHandle.getAttribute('aria-label')).toMatch(/start/i);

    void handle;
  });
});

describe('attachTimeSeriesBrush — pointer and keyboard selection', () => {
  it('drags the end handle and clamps to the domain without double inversion', () => {
    const container = mount();
    const handle = attachTimeSeriesBrush({ container, count: 90, width: 300, identity: '30d' });
    handles.push(handle);

    const endHandle = container.querySelector('[data-brush-handle="end"]') as HTMLElement;
    fire(endHandle, 'pointerdown');
    fire(container, 'pointermove', { clientX: 300 * 2 });
    fire(container, 'pointerup');

    expect(handle.getSelection().end).toBe(89);
  });

  it('resizes from both handles and clamps past each other', () => {
    const container = mount();
    const handle = attachTimeSeriesBrush({ container, count: 90, width: 300, identity: '30d' });
    handles.push(handle);

    const startHandle = container.querySelector('[data-brush-handle="start"]') as HTMLElement;
    fire(startHandle, 'pointerdown');
    // Drag the start handle toward the end: pixel 200 → index 59; the handle
    // clamps at the end handle and never crosses it.
    fire(container, 'pointermove', { clientX: 200 });
    fire(container, 'pointerup');

    const selection = handle.getSelection();
    expect(selection.end).toBe(89);
    expect(selection.start).toBe(59);

    // Dragging the start handle past the end clamps it at the end.
    fire(startHandle, 'pointerdown');
    fire(container, 'pointermove', { clientX: 300 });
    fire(container, 'pointerup');
    expect(handle.getSelection()).toEqual({ start: 89, end: 89 });

    // Set the end handle before the start: clamped and normalized.
    handle.setSelection({ start: 50, end: 20 });
    expect(handle.getSelection()).toEqual({ start: 20, end: 50 });

    handle.setSelection({ start: -10, end: 500 });
    expect(handle.getSelection()).toEqual({ start: 0, end: 89 });
  });

  it('supports arrow, page, and Home/End keyboard steps with accessible labels', () => {
    const container = mount();
    const handle = attachTimeSeriesBrush({ container, count: 90, width: 300, identity: '30d' });
    handles.push(handle);

    const startHandle = container.querySelector('[data-brush-handle="start"]') as HTMLElement;
    const endHandle = container.querySelector('[data-brush-handle="end"]') as HTMLElement;

    expect(startHandle.getAttribute('aria-valuemin')).toBe('0');
    expect(startHandle.getAttribute('aria-valuemax')).toBe('89');
    expect(startHandle.getAttribute('aria-valuenow')).toBe('60');

    startHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(handle.getSelection().start).toBe(61);

    startHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(handle.getSelection().start).toBe(60);

    startHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
    expect(handle.getSelection().start).toBe(67);

    startHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
    expect(handle.getSelection().start).toBe(60);

    startHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(handle.getSelection().start).toBe(0);

    endHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(handle.getSelection().end).toBe(89);
  });

  it('notifies selection changes for the main chart slice', () => {
    const container = mount();
    const changes: { start: number; end: number }[] = [];
    const handle = attachTimeSeriesBrush({
      container,
      count: 90,
      width: 300,
      identity: '30d',
      onSelectionChange: (selection) => changes.push({ ...selection }),
    });
    handles.push(handle);

    handle.setSelection({ start: 10, end: 40 });
    const startHandle = container.querySelector('[data-brush-handle="start"]') as HTMLElement;
    startHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));

    expect(changes).toEqual([
      { start: 10, end: 40 },
      { start: 11, end: 40 },
    ]);
  });
});

describe('attachTimeSeriesBrush — identity, revisions, and live appends', () => {
  it('resets on a period identity change and preserves selection across revisions', () => {
    const container = mount();
    const handle = attachTimeSeriesBrush({ container, count: 90, width: 300, identity: '30d' });
    handles.push(handle);

    handle.setSelection({ start: 5, end: 20 });

    // A service revision with the same range identity keeps the selection.
    handle.update({ count: 90, identity: '30d' });
    expect(handle.getSelection()).toEqual({ start: 5, end: 20 });

    // A period change resets to the latest window.
    handle.update({ count: 400, identity: 'all' });
    expect(handle.getSelection()).toEqual({ start: 370, end: 399 });
  });

  it('follows the latest data when the latest window is selected', () => {
    const container = mount();
    const handle = attachTimeSeriesBrush({ container, count: 90, width: 300, identity: '30d' });
    handles.push(handle);

    expect(handle.getSelection()).toEqual({ start: 60, end: 89 });

    // Live append: a new bucket arrives while the latest window is shown.
    handle.update({ count: 91, identity: '30d' });
    expect(handle.getSelection()).toEqual({ start: 61, end: 90 });

    // A pinned historical window does not drift on append.
    handle.setSelection({ start: 5, end: 20 });
    handle.update({ count: 92, identity: '30d' });
    expect(handle.getSelection()).toEqual({ start: 5, end: 20 });
  });

  it('destroys cleanly without document-level listener leaks', () => {
    const container = mount();
    const handle = attachTimeSeriesBrush({ container, count: 90, width: 300, identity: '30d' });

    handle.destroy();
    expect(container.querySelector('[data-brush-overview]')).toBeNull();

    // Listeners on the container no longer react.
    const before = handle.getSelection();
    fire(container, 'pointermove', { clientX: 150 });
    expect(handle.getSelection()).toEqual(before);
  });
});

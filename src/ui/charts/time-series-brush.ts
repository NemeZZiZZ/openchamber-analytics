import {
  BRUSH_OVERVIEW_HEIGHT,
  BRUSH_WINDOW_SIZE,
  clampSelection,
  defaultSelection,
  isBrushVisible,
  pixelToIndex,
  selectionToPixels,
  type BrushSelection,
} from './brush-geometry';
import { clearContainer } from './svg';

export type BrushHandle = {
  update(data: { count: number; identity: string; width?: number }): void;
  destroy(): void;
  getSelection(): BrushSelection;
  setSelection(selection: BrushSelection): void;
};

export type BrushOptions = {
  container: HTMLElement;
  count: number;
  width: number;
  /** Period/data identity; a change resets the selection intentionally. */
  identity: string;
  onSelectionChange?: (selection: BrushSelection) => void;
  formatRange?: (selection: BrushSelection) => string;
};

const PAGE_STEP = 7;

/**
 * The shared time-series brush: an exactly-32px overview with pointer and
 * keyboard selection. The selection lives in zero-based index space; the main
 * chart renders only the selected slice while the overview always shows every
 * bucket. The overview appears above 30 buckets, starts on the latest 30,
 * resets when the period identity changes, preserves the selection across
 * same-range revisions, and follows live appends while the latest window is
 * shown.
 */
export function attachTimeSeriesBrush(options: BrushOptions): BrushHandle {
  const container = options.container;
  const onSelectionChange = options.onSelectionChange;
  const formatRange = options.formatRange ?? ((selection: BrushSelection) => `buckets ${selection.start}–${selection.end}`);

  let count = options.count;
  let identity = options.identity;
  let width = options.width;
  let selection = clampSelection(defaultSelection(count), count);
  let disposed = false;
  let dragging: 'start' | 'end' | null = null;

  let overview: HTMLElement | null = null;
  let region: HTMLElement | null = null;
  let startHandle: HTMLElement | null = null;
  let endHandle: HTMLElement | null = null;

  const unsubs: (() => void)[] = [];

  function applySelection(next: BrushSelection, notify: boolean): void {
    selection = clampSelection(next, count);

    if (region && overview) {
      // Percent positioning keeps the region correct at any rendered width;
      // selection coordinates themselves stay in index space.
      const pixels = selectionToPixels(selection, count, width);
      const fraction = width > 0 ? pixels.startX / width : 0;
      const widthFraction = width > 0 ? pixels.width / width : 1;
      region.style.left = `${(fraction * 100).toFixed(2)}%`;
      region.style.width = `${(widthFraction * 100).toFixed(2)}%`;
    }

    if (startHandle) {
      startHandle.setAttribute('aria-valuenow', String(selection.start));
      startHandle.setAttribute('aria-valuetext', formatRange(selection));
    }

    if (endHandle) {
      endHandle.setAttribute('aria-valuenow', String(selection.end));
      endHandle.setAttribute('aria-valuetext', formatRange(selection));
    }

    if (notify) {
      onSelectionChange?.({ ...selection });
    }
  }

  function render(): void {
    clearContainer(container);

    if (!isBrushVisible(count) || disposed) {
      overview = null;
      region = null;
      startHandle = null;
      endHandle = null;
      return;
    }

    const root = document.createElement('div');
    root.className = 'an-brush';
    root.dataset['brushOverview'] = '';
    root.dataset['brushOverviewHeight'] = String(BRUSH_OVERVIEW_HEIGHT);
    root.style.height = `${BRUSH_OVERVIEW_HEIGHT}px`;

    const track = document.createElement('div');
    track.className = 'an-brush-track';

    region = document.createElement('div');
    region.className = 'an-brush-selection';
    region.dataset['brushSelection'] = '';
    track.append(region);

    const makeHandle = (kind: 'start' | 'end'): HTMLElement => {
      const handle = document.createElement('div');
      handle.className = `an-brush-handle an-brush-handle-${kind}`;
      handle.dataset['brushHandle'] = kind;
      handle.setAttribute('role', 'slider');
      handle.setAttribute('tabindex', '0');
      handle.setAttribute('aria-label', `${kind === 'start' ? 'Start' : 'End'} of visible range`);
      handle.setAttribute('aria-valuemin', '0');
      handle.setAttribute('aria-valuemax', String(Math.max(0, count - 1)));
      return handle;
    };

    startHandle = makeHandle('start');
    endHandle = makeHandle('end');
    track.append(startHandle, endHandle);
    root.append(track);
    container.append(root);
    overview = root;

    applySelection(selection, false);
    wireEvents();
  }

  function wireEvents(): void {
    if (!overview || !startHandle || !endHandle) {
      return;
    }

    const rectWidth = (): number => width || options.width;

    const indexFromEvent = (event: Event): number => {
      const rect = overview!.getBoundingClientRect();
      return pixelToIndex(event instanceof MouseEvent ? event.clientX - rect.left : 0, count, rect.width || rectWidth());
    };

    const onHandleDown = (kind: 'start' | 'end') => (event: Event): void => {
      event.preventDefault();
      dragging = kind;
      (event.target as HTMLElement).setPointerCapture?.((event as PointerEvent).pointerId ?? 1);
    };

    const onMove = (event: Event): void => {
      if (!dragging) {
        return;
      }

      const index = indexFromEvent(event);
      applySelection(
        dragging === 'start' ? { start: index, end: selection.end } : { start: selection.start, end: index },
        true,
      );
    };

    const onUp = (): void => {
      dragging = null;
    };

    const trackDown = (event: Event): void => {
      if ((event.target as HTMLElement).dataset['brushHandle']) {
        return;
      }

      const index = indexFromEvent(event);
      applySelection(defaultSelection(0), false);
      const half = Math.floor(BRUSH_WINDOW_SIZE / 2);
      applySelection({ start: index - half, end: index + half }, true);
    };

    overview.addEventListener('pointerdown', trackDown);
    startHandle.addEventListener('pointerdown', onHandleDown('start'));
    endHandle.addEventListener('pointerdown', onHandleDown('end'));
    container.addEventListener('pointermove', onMove);
    container.addEventListener('pointerup', onUp);

    unsubs.push(() => {
      overview?.removeEventListener('pointerdown', trackDown);
      startHandle?.removeEventListener('pointerdown', onHandleDown('start'));
      endHandle?.removeEventListener('pointerdown', onHandleDown('end'));
      container.removeEventListener('pointermove', onMove);
      container.removeEventListener('pointerup', onUp);
    });

    const onKey = (kind: 'start' | 'end') => (event: Event): void => {
      const key = (event as KeyboardEvent).key;
      const current = kind === 'start' ? selection.start : selection.end;
      let next: number | null = null;

      switch (key) {
        case 'ArrowRight':
          next = current + 1;
          break;
        case 'ArrowLeft':
          next = current - 1;
          break;
        case 'PageUp':
          next = current + PAGE_STEP;
          break;
        case 'PageDown':
          next = current - PAGE_STEP;
          break;
        case 'Home':
          next = 0;
          break;
        case 'End':
          next = count - 1;
          break;
        default:
          return;
      }

      event.preventDefault();
      applySelection(
        kind === 'start' ? { start: next, end: selection.end } : { start: selection.start, end: next },
        true,
      );
    };

    const startKey = onKey('start');
    const endKey = onKey('end');
    startHandle.addEventListener('keydown', startKey);
    endHandle.addEventListener('keydown', endKey);

    unsubs.push(() => {
      startHandle?.removeEventListener('keydown', startKey);
      endHandle?.removeEventListener('keydown', endKey);
    });
  }

  render();

  return {
    update(next) {
      if (disposed) {
        return;
      }

      const identityChanged = next.identity !== identity;
      const previousCount = count;
      count = next.count;
      identity = next.identity;
      width = next.width ?? width;

      if (identityChanged) {
        selection = clampSelection(defaultSelection(count), count);
        render();
        onSelectionChange?.({ ...selection });
        return;
      }

      if (next.count !== previousCount) {
        const wasFollowingLatest = selection.end >= previousCount - 1;

        if (wasFollowingLatest) {
          // Keep following the latest data on live appends.
          selection = clampSelection(defaultSelection(count), count);
        } else {
          selection = clampSelection(selection, count);
        }
      }

      render();
    },

    destroy() {
      if (disposed) {
        return;
      }

      disposed = true;

      for (const unsubscribe of unsubs.splice(0)) {
        unsubscribe();
      }

      clearContainer(container);
      overview = null;
      region = null;
      startHandle = null;
      endHandle = null;
    },

    getSelection() {
      return { ...selection };
    },

    setSelection(next) {
      if (disposed) {
        return;
      }

      applySelection(next, true);
    },
  };
}

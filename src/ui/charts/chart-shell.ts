import { observeContainerWidth } from '../resize-observer';

export type ChartShellHandle = {
  /** Re-renders with the current width. */
  update(): void;
  destroy(): void;
  width(): number;
};

export type ChartShellOptions = {
  /** Receives the measured container width; only called with usable widths. */
  render: (width: number) => void;
  /** Widths below this clear the shell instead of rendering clipped charts. */
  minWidth?: number;
  narrowMessage?: string;
};

/** Scrolls a horizontally scrollable grid to its most recent (right) end. */
export function scrollToLatest(scroller: HTMLElement): void {
  if (scroller.scrollWidth > scroller.clientWidth) {
    scroller.scrollLeft = scroller.scrollWidth;
  }
}

/**
 * Responsive chart shell: charts never render invalid SVG at zero width, redraw
 * on real width changes, and clean up their observers on destroy. Below the
 * minimum width the shell shows an explanatory placeholder instead of a
 * clipped chart.
 */
export function createChartShell(container: HTMLElement, options: ChartShellOptions): ChartShellHandle {
  const minWidth = options.minWidth ?? 40;
  const narrowMessage = options.narrowMessage ?? 'Too narrow to display this chart';
  let lastRenderedWidth = -1;
  let stopped = false;

  const placeholder = (): void => {
    container.textContent = '';

    const message = document.createElement('div');
    message.className = 'an-chart-narrow';
    message.setAttribute('role', 'status');
    message.textContent = narrowMessage;
    container.append(message);
  };

  const apply = (width: number): void => {
    if (stopped) {
      return;
    }

    if (width < minWidth) {
      if (lastRenderedWidth !== 0) {
        lastRenderedWidth = 0;
        placeholder();
      }

      return;
    }

    if (width === lastRenderedWidth) {
      return;
    }

    lastRenderedWidth = width;
    container.textContent = '';
    options.render(width);
  };

  const stopObserving = observeContainerWidth(container, apply);

  return {
    update() {
      apply(container.clientWidth);
    },

    destroy() {
      stopped = true;
      stopObserving();
      container.textContent = '';
    },

    width() {
      return lastRenderedWidth;
    },
  };
}

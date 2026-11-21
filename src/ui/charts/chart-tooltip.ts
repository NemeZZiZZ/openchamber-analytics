/**
 * One shared chart tooltip controller for every chart kind. Renders fixed to
 * the iframe viewport with a single pointer offset, flips away from viewport
 * edges, and builds all content through text nodes — hostile labels never
 * become markup.
 */

export type TooltipRow = {
  color?: string;
  label: string;
  value: string;
};

export type TooltipContent = {
  title: string;
  rows: TooltipRow[];
};

export type TooltipAnchor = {
  clientX: number;
  clientY: number;
};

export type ChartTooltip = {
  show(content: TooltipContent, anchor: TooltipAnchor): void;
  hide(): void;
  /**
   * Wires pointer behavior onto one chart container (an svg root or a grid).
   * The resolver runs per pointermove; returning null keeps the currently
   * shown content, so crossing gaps between shapes never hides the tooltip.
   * Only leaving the container as a whole hides it.
   */
  attachPointerTo(container: Element, resolve: (event: PointerEvent) => TooltipContent | null): () => void;
  /** Wires keyboard behavior (focus, Escape, blur) onto one focusable shape. */
  attachKeyboardTo(target: Element, resolve: () => TooltipContent | null): () => void;
  destroy(): void;
};

export type ChartTooltipOptions = {
  zIndex?: number;
};

const OFFSET_X = 12;
const OFFSET_Y = 12;
const VIEWPORT_MARGIN = 8;

export function createChartTooltip(options: ChartTooltipOptions = {}): ChartTooltip {
  const zIndex = options.zIndex ?? 1000;
  let element: HTMLElement | null = null;
  let currentAnchor: TooltipAnchor = { clientX: 0, clientY: 0 };

  function ensureElement(): HTMLElement {
    if (element) {
      return element;
    }

    const created = document.createElement('div');
    created.className = 'an-chart-tooltip an-max-w-320';
    created.setAttribute('role', 'tooltip');
    created.style.position = 'fixed';
    created.style.zIndex = String(zIndex);
    created.style.pointerEvents = 'none';
    created.style.left = '0px';
    created.style.top = '0px';
    document.body.append(created);
    element = created;
    return created;
  }

  function position(): void {
    if (!element) {
      return;
    }

    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const rect = element.getBoundingClientRect();
    const width = rect.width || 280;
    const height = rect.height || 80;

    let left = currentAnchor.clientX + OFFSET_X;
    let top = currentAnchor.clientY + OFFSET_Y;

    if (left + width + VIEWPORT_MARGIN > viewportWidth) {
      left = currentAnchor.clientX - OFFSET_X - width;
    }

    if (top + height + VIEWPORT_MARGIN > viewportHeight) {
      top = currentAnchor.clientY - OFFSET_Y - height;
    }

    left = Math.max(VIEWPORT_MARGIN, left);
    top = Math.max(VIEWPORT_MARGIN, top);

    element.style.left = `${Math.round(left)}px`;
    element.style.top = `${Math.round(top)}px`;
  }

  return {
    show(content, anchor) {
      currentAnchor = anchor;

      const target = ensureElement();
      target.textContent = '';

      const title = document.createElement('div');
      title.className = 'an-tooltip-title';
      title.textContent = content.title;
      target.append(title);

      for (const row of content.rows) {
        const rowElement = document.createElement('div');
        rowElement.className = 'an-tooltip-row';

        if (row.color) {
          const swatch = document.createElement('span');
          swatch.className = 'an-tooltip-swatch';
          swatch.style.backgroundColor = row.color;
          rowElement.append(swatch);
        }

        const label = document.createElement('span');
        label.className = 'an-tooltip-label';
        label.textContent = row.label;
        rowElement.append(label);

        const value = document.createElement('span');
        value.className = 'an-tooltip-value';
        value.textContent = row.value;
        rowElement.append(value);

        target.append(rowElement);
      }

      position();
    },

    hide() {
      if (element) {
        element.remove();
        element = null;
      }
    },

    attachPointerTo(container, resolve) {
      const onMove = (event: Event): void => {
        const pointer = event as PointerEvent;
        const content = resolve(pointer);

        if (content) {
          this.show(content, { clientX: pointer.clientX, clientY: pointer.clientY });
        }
      };

      const onLeave = (): void => {
        this.hide();
      };

      container.addEventListener('pointermove', onMove);
      container.addEventListener('pointerleave', onLeave);

      return () => {
        container.removeEventListener('pointermove', onMove);
        container.removeEventListener('pointerleave', onLeave);
      };
    },

    attachKeyboardTo(target, resolve) {
      const onFocus = (): void => {
        const content = resolve();

        if (content) {
          const rect = target.getBoundingClientRect();
          this.show(content, { clientX: rect.left + Math.min(rect.width, 24), clientY: rect.top });
        }
      };

      const onLeave = (): void => {
        this.hide();
      };

      const onKeyDown = (event: Event): void => {
        if ((event as KeyboardEvent).key === 'Escape') {
          this.hide();
        }
      };

      target.addEventListener('focus', onFocus);
      target.addEventListener('blur', onLeave);
      target.addEventListener('keydown', onKeyDown);

      return () => {
        target.removeEventListener('focus', onFocus);
        target.removeEventListener('blur', onLeave);
        target.removeEventListener('keydown', onKeyDown);
      };
    },

    destroy() {
      this.hide();
    },
  };
}

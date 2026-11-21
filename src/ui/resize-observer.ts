/**
 * Container-width observation shared by every responsive chart shell.
 * Fires the initial width immediately and every actual width change after.
 */
export function observeContainerWidth(element: HTMLElement, callback: (width: number) => void): () => void {
  let lastWidth = -1;
  let stopped = false;

  const notify = (width: number): void => {
    if (stopped || width === lastWidth) {
      return;
    }

    lastWidth = width;
    callback(width);
  };

  notify(element.clientWidth);

  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver((entries) => {
    for (const entry of entries) {
      const width = entry.contentRect.width || (entry.target as HTMLElement).clientWidth;
      notify(Math.floor(width));
    }
  }) : null;

  if (observer) {
    observer.observe(element);
  } else {
    // Environments without ResizeObserver: fall back to resize polling.
    const onResize = (): void => notify(element.clientWidth);
    window.addEventListener('resize', onResize);
    return () => {
      stopped = true;
      window.removeEventListener('resize', onResize);
    };
  }

  return () => {
    stopped = true;
    observer.disconnect();
  };
}

export type SurfaceSize = 's' | 'm' | 'l';

export const SMALL_PX = 420;
export const WIDE_PX = 720;

export function sizeForWidth(width: number): SurfaceSize {
  return width < SMALL_PX ? 's' : width < WIDE_PX ? 'm' : 'l';
}

/** Mirrors the container width into `data-size` so the stylesheet can respond. */
export function bindSurfaceSize(element: HTMLElement): () => void {
  return observeContainerWidth(element, (width) => {
    element.dataset['size'] = sizeForWidth(width);
  });
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/**
 * Creates a namespaced SVG element with attributes. All text content must go
 * through textContent assignments — innerHTML is forbidden for anything that
 * can carry model or title strings.
 */
export function svgEl(tag: string, attributes: Record<string, string | number> = {}): SVGElement {
  const element = document.createElementNS(SVG_NAMESPACE, tag);

  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }

  return element;
}

/** Replaces all attributes on an existing SVG element. */
export function updateAttrs(element: Element, attributes: Record<string, string | number>): void {
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, String(value));
  }
}

/** Renders a small muted empty-state text node inside a chart container. */
export function renderEmptyState(container: HTMLElement, message = 'No data'): void {
  const empty = document.createElement('div');
  empty.className = 'an-chart-empty';
  empty.setAttribute('role', 'status');
  empty.textContent = message;
  container.append(empty);
}

export function clearContainer(container: HTMLElement): void {
  container.textContent = '';
}

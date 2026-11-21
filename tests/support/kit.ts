// jsdom has no scrollIntoView; the SDK select highlights options with it.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

/** Opens an SDK select inside `slot` and picks the option with the given label. */
export function pickOption(slot: Element, label: string): void {
  (slot.querySelector('.oc-sdk-trigger') as HTMLButtonElement).click();
  const options = [...slot.querySelectorAll<HTMLButtonElement>('.oc-sdk-option')];
  // Hinted options concatenate label + hint in textContent, so an exact match
  // wins but a label prefix is accepted as a fallback.
  const option = options.find((candidate) => candidate.textContent?.trim() === label)
    ?? options.find((candidate) => candidate.textContent?.trim().startsWith(label));

  if (!option) {
    throw new Error(`No select option labelled "${label}"`);
  }

  option.click();
}

export function selectedLabel(slot: Element): string {
  return slot.querySelector('.oc-sdk-trigger-value')?.textContent?.trim() ?? '';
}

export function tab(slot: Element, id: string): HTMLButtonElement | null {
  return slot.querySelector<HTMLButtonElement>(`.oc-sdk-tab[data-id="${id}"]`);
}

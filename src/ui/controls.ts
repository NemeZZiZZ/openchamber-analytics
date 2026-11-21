import {
  mountButton,
  mountSelect,
  mountTabs,
  type ButtonHandle,
  type SelectHandle,
  type SelectOption,
  type TabsHandle,
} from '@openchamber/sdk/ui';

/**
 * Thin wrappers over the SDK UI kit so the page and the panel share the exact
 * controls the other OpenChamber extensions use. Every wrapper returns the
 * mount slot (for stable data-attributes) and a disposable handle.
 */

export type ControlOption = {
  value: string;
  label: string;
  hint?: string;
  /** Disabled rows render dimmed and cannot be picked. */
  disabled?: boolean;
};

export type Disposable = { dispose(): void };

export type Slot<H> = { element: HTMLElement; handle: H };

export function createSlot(className = 'an-slot'): HTMLElement {
  const element = document.createElement('span');
  element.className = className;
  return element;
}

/** Collects kit handles so a re-render can dispose them in one call. */
export function createScope(): { keep<T extends Disposable>(handle: T): T; reset(): void } {
  const handles: Disposable[] = [];

  return {
    keep(handle) {
      handles.push(handle);
      return handle;
    },
    reset() {
      for (const handle of handles.splice(0)) {
        handle.dispose();
      }
    },
  };
}

export function createSelectControl(options: {
  options: ControlOption[];
  value: string;
  ariaLabel: string;
  /** Adds an SDK search box to the popup; useful for long option lists. */
  searchable?: boolean;
  onChange: (value: string) => void;
}): Slot<SelectHandle> {
  const element = createSlot();
  // The SDK option model has no disabled flag in its types but honors it at
  // runtime (createOption sets button.disabled), so it travels as extra data.
  const handle = mountSelect(element, {
    value: options.value,
    options: options.options.map((option) => ({
      id: option.value,
      label: option.label,
      hint: option.hint,
      disabled: option.disabled,
    })) as SelectOption[],
    searchable: options.searchable,
    onChange: options.onChange,
  });

  // The kit labels its trigger through an (empty) caption element; give it a
  // real accessible name instead.
  const trigger = element.querySelector('.oc-sdk-trigger');
  trigger?.removeAttribute('aria-labelledby');
  trigger?.setAttribute('aria-label', options.ariaLabel);

  return { element, handle };
}

export function createTabsControl(options: {
  options: ControlOption[];
  value: string;
  ariaLabel: string;
  onChange: (value: string) => void;
}): Slot<TabsHandle> {
  const element = createSlot();
  const handle = mountTabs(element, {
    items: options.options.map((option) => ({ id: option.value, label: option.label })),
    activeId: options.value,
    onChange: options.onChange,
    trackBackground: true,
  });

  element.querySelector('.oc-sdk-tabs')?.setAttribute('aria-label', options.ariaLabel);
  return { element, handle };
}

export function createButtonControl(options: {
  label: string;
  onClick: () => void;
  loading?: boolean;
}): Slot<ButtonHandle> {
  const element = createSlot();
  const handle = mountButton(element, {
    label: options.label,
    variant: 'outline',
    size: 'xs',
    loading: options.loading,
    onClick: options.onClick,
  });

  return { element, handle };
}

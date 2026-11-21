import type { ProjectEntry } from './analytics-types';
import { formatCompactNumber } from './formatting';

/** Select-only divider row between the built-in scopes and the project list. */
export const PROJECT_SEPARATOR = '__separator__';

/** Search appears in the project picker once the list grows past this size. */
export const PROJECT_SEARCH_THRESHOLD = 15;

const SEPARATOR_LABEL = '────────────';

export type ProjectSelectOption = {
  value: string;
  label: string;
  hint?: string;
  /** Disabled rows render dimmed and cannot be picked (the divider). */
  disabled?: boolean;
};

function projectHint(project: ProjectEntry): string {
  return `${formatCompactNumber(project.tokens)} tok · ${formatCompactNumber(project.sessions)} sessions`;
}

/**
 * Options for the shared project filter: All projects, This project (only
 * while the host reports a directory), a divider, then every known project.
 * A pinned project missing from the list keeps its own entry so the select
 * never shows an unlabelled value.
 */
export function projectSelectOptions(input: {
  hasDirectory: boolean;
  projects?: readonly ProjectEntry[];
  pinned?: string;
}): ProjectSelectOption[] {
  const options: ProjectSelectOption[] = [{ value: 'all', label: 'All projects' }];

  if (input.hasDirectory) {
    options.push({ value: 'this', label: 'This project' });
  }

  const projects = input.projects ?? [];

  if (projects.length > 0) {
    options.push({ value: PROJECT_SEPARATOR, label: SEPARATOR_LABEL, disabled: true });
  }

  for (const project of projects) {
    options.push({ value: project.directory, label: project.label, hint: projectHint(project) });
  }

  if (input.pinned !== undefined && !projects.some((project) => project.directory === input.pinned)) {
    options.push({
      value: input.pinned,
      label: pinnedLabel(input.pinned),
      hint: projectHint({ directory: input.pinned, label: '', sessions: 0, tokens: 0, cost: 0 }),
    });
  }

  return options;
}

/** Final non-empty directory segment, falling back to the full directory. */
function pinnedLabel(directory: string): string {
  const segments = directory.split(/[\\/]/).filter((segment) => segment !== '');
  return segments.at(-1) ?? directory;
}

/** The select value matching the current filter state. */
export function projectSelectValue(scope: 'all' | 'project', directory: string | undefined): string {
  if (scope === 'all') {
    return 'all';
  }

  return directory ?? 'this';
}

/**
 * Maps a chosen select value to a filter patch. "This project" carries no
 * directory so the surface controller follows the host; the separator is not
 * a selection at all.
 */
export function projectFilterPatch(value: string): { scope: 'all' | 'project'; directory?: string } | null {
  if (value === PROJECT_SEPARATOR) {
    return null;
  }

  if (value === 'all') {
    return { scope: 'all' };
  }

  if (value === 'this') {
    return { scope: 'project' };
  }

  return { scope: 'project', directory: value };
}

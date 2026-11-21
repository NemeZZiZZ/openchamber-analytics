import type { ProjectEntry, StoredSessionAnalytics } from '../shared/analytics-types';
import { eventTokens } from '../shared/analytics-types';
import { projectLabel } from './aggregate-models';
import { normalizeDirectory } from './scope';

/**
 * Distinct project directories across the whole store, aggregated over all
 * time. The active filters never apply here: a snapshot scoped to one project
 * must still list every project so the picker stays complete. Sorted by
 * all-time tokens descending with a label tie-break; directories normalize so
 * trailing separators and path styles collapse into one entry.
 */
export function listProjects(records: readonly StoredSessionAnalytics[]): ProjectEntry[] {
  const projects = new Map<string, { sessions: number; tokens: number; cost: number }>();

  for (const record of records) {
    // An empty directory is the unknown-session marker, not a real project;
    // normalizeDirectory maps it to '/', so bail out before normalization.
    if (record.session.directory === '') {
      continue;
    }

    const directory = normalizeDirectory(record.session.directory);

    const entry = projects.get(directory) ?? { sessions: 0, tokens: 0, cost: 0 };
    entry.sessions += 1;

    for (const event of record.events) {
      entry.tokens += eventTokens(event);
      entry.cost += event.cost;
    }

    projects.set(directory, entry);
  }

  return [...projects.entries()]
    .map(([directory, entry]) => ({
      directory,
      label: projectLabel(directory),
      sessions: entry.sessions,
      tokens: entry.tokens,
      cost: entry.cost,
    }))
    .sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));
}

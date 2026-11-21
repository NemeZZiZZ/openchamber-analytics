import type { AnalyticsFilters, StoredSessionAnalytics } from '../shared/analytics-types';

export function normalizeDirectory(directory: string): string {
  // Windows and POSIX separators compare equal; Windows drive paths are
  // case-insensitive.
  const unified = directory.replace(/\\/g, '/').replace(/\/+$/, '');
  const windows = /^[a-zA-Z]:/.test(unified);
  const result = unified === '' ? '/' : unified;
  return windows ? result.toLowerCase() : result;
}

/** Sessions visible under the snapshot scope. */
export function scopeRecords(records: StoredSessionAnalytics[], filters: AnalyticsFilters): StoredSessionAnalytics[] {
  if (filters.scope !== 'project' || filters.directory === undefined) {
    return records;
  }

  const directory = normalizeDirectory(filters.directory);
  return records.filter((record) => normalizeDirectory(record.session.directory) === directory);
}

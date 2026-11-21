/**
 * Validates an IANA timezone string through Intl. Missing, empty, or invalid
 * values fall back to UTC so every snapshot carries an effective timezone.
 */
export function resolveTimeZone(input?: string | null): string {
  if (typeof input === 'string' && input.trim() !== '') {
    try {
      // Throws for unknown zones; en-US hourCycle is irrelevant to validation.
      new Intl.DateTimeFormat('en-US', { timeZone: input.trim() });
      return input.trim();
    } catch {
      // fall through to UTC
    }
  }

  return 'UTC';
}

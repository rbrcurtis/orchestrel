/** One timestamp format for transcript rows, dividers, and the session-start row. */
const ENTRY_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function formatEntryTime(timestamp?: number): string | null {
  if (!timestamp) return null;
  return ENTRY_TIME_FORMATTER.format(new Date(timestamp));
}

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  year: "numeric",
});

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/**
 * Compact, single-line dates: the short forms keep the audit and account tables
 * to one line per cell instead of wrapping the full "Month d, yyyy" spelling.
 */
export function formatDate(value: string | Date): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dateFormatter.format(date);
}

/** Keep the year so older audit records remain unambiguous. */
export function formatDateTime(value: string | Date): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dateTimeFormatter.format(date);
}

/** Compact token counts: 1.2K / 3.4M rather than long digit runs. */
export function formatCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) {
    return `${trimZero((value / 1_000).toFixed(1))}K`;
  }
  if (value < 1_000_000_000) {
    return `${trimZero((value / 1_000_000).toFixed(1))}M`;
  }
  return `${trimZero((value / 1_000_000_000).toFixed(1))}B`;
}

function trimZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}

/** The accounting month is based on UTC, independent of display timezone. */
export function formatUsagePeriod(startsAt: string): string {
  if (Number.isNaN(new Date(startsAt).getTime())) return "—";
  return `${new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(startsAt))} (UTC)`;
}

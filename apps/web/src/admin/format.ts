const dateFormatter = new Intl.DateTimeFormat("en", {
  year: "numeric",
  month: "short",
  day: "2-digit",
});

const dateTimeFormatter = new Intl.DateTimeFormat("en", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDate(value: string | Date): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : dateFormatter.format(date);
}

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

/** "Sep 2026 (UTC)" — surfaces the billing-window basis of usage numbers. */
export function formatUsagePeriod(startsAt: string): string {
  return `${new Intl.DateTimeFormat("en", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(startsAt))} (UTC)`;
}

export type AutomationSchedule =
  | { type: "once"; at: string }
  | { type: "daily"; time: string }
  | { type: "weekly"; weekdays: number[]; time: string };

export class InvalidAutomationScheduleError extends Error {
  readonly code = "AUTOMATION_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "InvalidAutomationScheduleError";
  }
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timezone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    formatter.format(new Date());
  } catch {
    throw new InvalidAutomationScheduleError("Unknown time zone");
  }
  formatters.set(timezone, formatter);
  return formatter;
}

interface LocalParts {
  hour: number;
  minute: number;
  weekday: number;
}

function localParts(date: Date, timezone: string): LocalParts {
  const values: Record<string, string> = {};
  for (const part of formatterFor(timezone).formatToParts(date)) {
    values[part.type] = part.value;
  }
  const weekdayIndex = WEEKDAY_LABELS.indexOf(values.weekday ?? "");
  return {
    hour: Number(values.hour === "24" ? "0" : values.hour),
    minute: Number(values.minute),
    weekday: weekdayIndex <= 0 ? (weekdayIndex === 0 ? 7 : 0) : weekdayIndex,
  };
}

function parseTime(value: unknown): { hour: number; minute: number } {
  if (typeof value !== "string" || !TIME_PATTERN.test(value)) {
    throw new InvalidAutomationScheduleError("Time must be HH:mm");
  }
  return { hour: Number(value.slice(0, 2)), minute: Number(value.slice(3, 5)) };
}

export function parseAutomationSchedule(value: unknown): AutomationSchedule {
  if (typeof value !== "object" || value === null) {
    throw new InvalidAutomationScheduleError("Schedule must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.type === "once") {
    if (typeof record.at !== "string") {
      throw new InvalidAutomationScheduleError(
        "Once schedule needs an ISO time",
      );
    }
    const at = new Date(record.at);
    if (Number.isNaN(at.getTime())) {
      throw new InvalidAutomationScheduleError("Invalid once time");
    }
    return { type: "once", at: at.toISOString() };
  }
  if (record.type === "daily") {
    const time = record.time;
    parseTime(time);
    return { type: "daily", time: time as string };
  }
  if (record.type === "weekly") {
    if (!Array.isArray(record.weekdays) || record.weekdays.length === 0) {
      throw new InvalidAutomationScheduleError(
        "Weekly schedule needs weekdays",
      );
    }
    const weekdays = [...new Set(record.weekdays)];
    if (
      weekdays.some(
        (day) =>
          !Number.isInteger(day) || (day as number) < 1 || (day as number) > 7,
      )
    ) {
      throw new InvalidAutomationScheduleError("Weekdays must be 1–7");
    }
    const time = record.time;
    parseTime(time);
    return {
      type: "weekly",
      weekdays: weekdays as number[],
      time: time as string,
    };
  }
  throw new InvalidAutomationScheduleError("Unknown schedule type");
}

export function formatAutomationSchedule(schedule: AutomationSchedule): string {
  if (schedule.type === "once") {
    return new Date(schedule.at).toLocaleString("zh-CN");
  }
  if (schedule.type === "daily") return `每天 ${schedule.time}`;
  return `每周 ${schedule.weekdays.join(",")} ${schedule.time}`;
}

/**
 * Finds the next UTC instant whose wall clock in `timezone` matches the rule.
 * Minute scanning is deliberate: it is correct across DST transitions without
 * a timezone database, and runs only when a rule is created or advanced.
 */
export function computeNextRunAt(
  schedule: AutomationSchedule,
  timezone: string,
  after: Date,
): Date | null {
  formatterFor(timezone);
  if (schedule.type === "once") {
    const at = new Date(schedule.at);
    return at.getTime() > after.getTime() ? at : null;
  }
  const { hour, minute } = parseTime(schedule.time);
  const start = new Date(Math.ceil((after.getTime() + 1) / 60_000) * 60_000);
  const maxMinutes = schedule.type === "weekly" ? 8 * 24 * 60 : 2 * 24 * 60;
  for (let index = 0; index < maxMinutes; index += 1) {
    const candidate = new Date(start.getTime() + index * 60_000);
    const parts = localParts(candidate, timezone);
    if (parts.hour !== hour || parts.minute !== minute) continue;
    if (
      schedule.type === "weekly" &&
      !schedule.weekdays.includes(parts.weekday)
    ) {
      continue;
    }
    return candidate;
  }
  return null;
}

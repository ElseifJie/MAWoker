import { describe, expect, it } from "vitest";
import {
  computeNextRunAt,
  InvalidAutomationScheduleError,
  parseAutomationSchedule,
} from "../packages/domain/src/index.js";

describe("automation schedule", () => {
  it("resolves the next daily wall-clock time in an IANA zone", () => {
    const next = computeNextRunAt(
      { type: "daily", time: "09:00" },
      "Asia/Shanghai",
      new Date("2026-10-17T00:00:00.000Z"),
    );
    expect(next?.toISOString()).toBe("2026-10-17T01:00:00.000Z");
  });

  it("resolves the next weekly weekday", () => {
    const next = computeNextRunAt(
      { type: "weekly", weekdays: [1], time: "09:00" },
      "Asia/Shanghai",
      new Date("2026-10-16T00:00:00.000Z"),
    );
    expect(next?.toISOString()).toBe("2026-10-19T01:00:00.000Z");
  });

  it("keeps once schedules absolute and rejects the past", () => {
    const schedule = parseAutomationSchedule({
      type: "once",
      at: "2026-10-18T00:00:00.000Z",
    });
    expect(
      computeNextRunAt(
        schedule,
        "UTC",
        new Date("2026-10-17T00:00:00.000Z"),
      )?.toISOString(),
    ).toBe("2026-10-18T00:00:00.000Z");
    expect(
      computeNextRunAt(schedule, "UTC", new Date("2026-10-19T00:00:00.000Z")),
    ).toBeNull();
  });

  it("rejects malformed schedules and unknown time zones", () => {
    expect(() =>
      parseAutomationSchedule({ type: "daily", time: "25:00" }),
    ).toThrow(InvalidAutomationScheduleError);
    expect(() =>
      parseAutomationSchedule({ type: "weekly", weekdays: [0], time: "09:00" }),
    ).toThrow(InvalidAutomationScheduleError);
    expect(() =>
      computeNextRunAt(
        { type: "daily", time: "09:00" },
        "Not/AZone",
        new Date(),
      ),
    ).toThrow(InvalidAutomationScheduleError);
  });
});

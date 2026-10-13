import { describe, expect, it } from "vitest";
import type { SessionSummary, SessionTurn, SubmissionReceipt } from "./api.js";
import { canStopTask, taskStatus } from "./task-status.js";

export const task: SessionSummary = {
  id: "task",
  title: "Research",
  status: "idle",
  upstreamReady: true,
  error: null,
  deletionState: "none",
  archivedAt: null,
  pinnedAt: null,
  lastEventAt: null,
  createdAt: "2026-10-13T10:00:00Z",
  updatedAt: "2026-10-13T10:00:00Z",
  agent: { id: "agent", name: "Helper", kind: "personal", version: "1" },
};
export const turn: SessionTurn = {
  id: "turn",
  outcome: "completed",
  artifactState: "synced",
  artifactIds: [],
  summary: "Result",
  usageState: "complete",
  errorCode: null,
  endedAt: "2026-10-13T11:00:00Z",
};
export function receipt(
  status: SubmissionReceipt["status"],
): SubmissionReceipt {
  return {
    submissionId: "request",
    status,
    content: "Continue",
    createdAt: "2026-10-13T12:00:00Z",
    upstreamEventId: null,
    errorCode: null,
  };
}

describe("task status evidence", () => {
  it("does not report arbitrary idle or an idle transcript as completed", () => {
    expect(taskStatus(task).label).toBe("待开始");
    expect(
      taskStatus(task, undefined, [
        { kind: "assistant", id: "a", ts: task.createdAt, text: "Hello" },
      ]).label,
    ).toBe("待开始");
  });
  it.each([
    ["completed", "本轮完成"],
    ["waiting", "等待补充"],
    ["failed", "执行失败"],
    ["confirming", "确认中"],
  ] as const)("uses persisted %s outcome", (outcome, label) => {
    expect(taskStatus(task, { ...turn, outcome }).label).toBe(label);
  });
  it.each(["queued", "sending", "unknown", "accepted"] as const)(
    "does not reuse completion for newer %s submission",
    (status) => {
      expect(
        taskStatus({ ...task, submissions: [receipt(status)] }, turn).label,
      ).toBe(status === "queued" || status === "sending" ? "准备中" : "确认中");
    },
  );
  it("does not reuse a completed turn when newer timeline activity arrives", () => {
    expect(
      taskStatus(task, turn, [
        {
          kind: "user",
          id: "next",
          ts: receipt("accepted").createdAt,
          text: "Next",
        },
      ]).label,
    ).toBe("确认中");
  });
  it("uses a failed newer receipt and keeps synchronization uncertainty neutral", () => {
    expect(
      taskStatus({ ...task, submissions: [receipt("failed")] }, turn).label,
    ).toBe("发送失败");
    expect(taskStatus(task, { ...turn, artifactState: "failed" }).label).toBe(
      "确认中",
    );
  });
  it("keeps unknown delivery protection even while upstream says running", () => {
    expect(
      taskStatus(
        { ...task, status: "running", submissions: [receipt("unknown")] },
        turn,
      ).label,
    ).toBe("确认中");
  });
  it("does not hide an unresolved old receipt behind a newer completed turn", () => {
    expect(
      taskStatus(
        {
          ...task,
          submissions: [{ ...receipt("unknown"), createdAt: task.createdAt }],
        },
        turn,
      ).label,
    ).toBe("确认中");
  });
  it("does not claim completion when receipt chronology cannot be verified", () => {
    expect(
      taskStatus(
        {
          ...task,
          submissions: [{ ...receipt("accepted"), createdAt: "invalid" }],
        },
        turn,
      ).label,
    ).toBe("确认中");
  });
  it.each(["pending", "deletion_failed", "deleted"] as const)(
    "does not report completion during %s deletion",
    (deletionState) => {
      expect(taskStatus({ ...task, deletionState }, turn).label).not.toBe(
        "本轮完成",
      );
    },
  );
});

describe("stop permission", () => {
  it.each(["initializing", "upgrading", "running", "rescheduled"] as const)(
    "allows an upstream-ready %s task",
    (status) => expect(canStopTask({ ...task, status })).toBe(true),
  );
  it.each(["idle", "failed", "terminated"] as const)(
    "does not offer stop for %s",
    (status) => expect(canStopTask({ ...task, status })).toBe(false),
  );
  it.each([false, undefined])(
    "requires explicit readiness, not %s",
    (upstreamReady) => {
      expect(canStopTask({ ...task, status: "running", upstreamReady })).toBe(
        false,
      );
    },
  );
  it.each(["pending", "deletion_failed", "deleted"] as const)(
    "blocks stop during %s",
    (deletionState) => {
      expect(canStopTask({ ...task, status: "running", deletionState })).toBe(
        false,
      );
    },
  );
});

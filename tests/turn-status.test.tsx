// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TurnStatus } from "../apps/web/src/components/TurnStatus.js";

const turn = {
  id: "turn",
  outcome: "completed" as const,
  artifactState: "failed" as const,
  artifactIds: [],
  summary: "**完整回答**".repeat(100),
  usageState: "pending" as const,
  errorCode: "ARTIFACTS_NOT_VISIBLE",
  endedAt: "2026-10-13",
};
afterEach(cleanup);

it("keeps long answer text out of the alert when the transcript already contains it", () => {
  const recover = vi.fn();
  render(
    <TurnStatus
      turn={turn}
      hasAnswer
      disabled={false}
      recovering={false}
      onRecover={recover}
    />,
  );
  expect(screen.getByRole("alert")).not.toHaveTextContent(turn.summary);
  expect(screen.queryByText(/完整回答/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重试同步" }));
  expect(recover).toHaveBeenCalledOnce();
  expect(screen.getByText("ARTIFACTS_NOT_VISIBLE")).toBeInTheDocument();
});

it("preserves the unique summary as formatted result content when there is no transcript answer", () => {
  render(
    <TurnStatus
      turn={{ ...turn, summary: "**唯一摘要**" }}
      hasAnswer={false}
      disabled={false}
      recovering={false}
      onRecover={vi.fn()}
    />,
  );
  expect(screen.getByRole("region", { name: "结果摘要" })).toHaveTextContent(
    "唯一摘要",
  );
  expect(screen.getByText("唯一摘要").tagName).toBe("STRONG");
  expect(screen.getByRole("alert")).not.toHaveTextContent("唯一摘要");
});

it("does not claim completed results while the round outcome is still confirming", () => {
  render(
    <TurnStatus
      turn={{
        ...turn,
        outcome: "confirming",
        artifactState: "synced",
        summary: "尚待核对的结果",
      }}
      hasAnswer={false}
      disabled={false}
      recovering={false}
      onRecover={vi.fn()}
    />,
  );
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByRole("region", { name: "结果摘要" })).toHaveTextContent(
    "尚待核对的结果",
  );
});

it("uses the persisted completed outcome for a round that produced no files", () => {
  render(
    <TurnStatus
      turn={{
        ...turn,
        outcome: "completed",
        artifactState: "none",
        summary: "正文结果",
      }}
      hasAnswer={false}
      disabled={false}
      recovering={false}
      onRecover={vi.fn()}
    />,
  );
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.getByRole("region", { name: "结果摘要" })).toHaveTextContent(
    "正文结果",
  );
});

it("keeps routine background work out of the conversation while preserving the unique answer", () => {
  render(
    <TurnStatus
      turn={{
        ...turn,
        outcome: "completed",
        artifactState: "pending",
        errorCode: "ARTIFACT_SYNC_FAILED",
        summary: "已收到的回答",
      }}
      hasAnswer={false}
      recovering={false}
      disabled={false}
      onRecover={vi.fn()}
    />,
  );
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByText("用量统计中")).toBeNull();
  expect(screen.queryByText("ARTIFACT_SYNC_FAILED")).toBeNull();
  expect(screen.getByRole("region", { name: "结果摘要" })).toHaveTextContent(
    "已收到的回答",
  );
});

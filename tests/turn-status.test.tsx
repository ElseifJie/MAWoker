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
  expect(screen.getByRole("status")).not.toHaveTextContent("本轮结果已同步。");
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
  expect(screen.getByRole("status")).toHaveTextContent("本轮完成");
  expect(screen.getByRole("status")).not.toHaveTextContent("后台同步");
  expect(screen.getByRole("region", { name: "结果摘要" })).toHaveTextContent(
    "正文结果",
  );
});

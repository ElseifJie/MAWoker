import type { SessionSummary, SessionTurn } from "./api.js";
import type { Item } from "./timeline/items.js";
import type { BadgeTone } from "./ui/index.js";

export function taskStatus(
  session: SessionSummary,
  turn?: SessionTurn,
  items: readonly Item[] = [],
): { label: string; tone: BadgeTone } {
  if (session.deletionState === "pending")
    return { label: "删除中", tone: "warning" };
  if (session.deletionState === "deletion_failed")
    return { label: "删除失败", tone: "danger" };
  if (session.deletionState === "deleted")
    return { label: "已删除", tone: "neutral" };
  if (session.status === "terminated")
    return { label: "任务已结束", tone: "neutral" };
  const boundary = turn ? Date.parse(turn.endedAt) : -Infinity;
  const receipts = (session.submissions ?? []).filter(
    (item) =>
      !turn ||
      ["queued", "sending", "unknown"].includes(item.status) ||
      !Number.isFinite(Date.parse(item.createdAt)) ||
      !Number.isFinite(boundary) ||
      Date.parse(item.createdAt) > boundary,
  );
  if (receipts.some((item) => item.status === "unknown"))
    return { label: "确认中", tone: "warning" };
  if (session.status === "failed") return { label: "执行失败", tone: "danger" };
  if (session.status === "running") return { label: "执行中", tone: "success" };
  if (
    session.status === "initializing" ||
    session.status === "upgrading" ||
    receipts.some(
      (item) => item.status === "queued" || item.status === "sending",
    )
  )
    return { label: "准备中", tone: "neutral" };
  if (session.status === "rescheduled")
    return { label: "等待重试", tone: "warning" };
  const newest = receipts.reduce<(typeof receipts)[number] | undefined>(
    (latest, item) =>
      !latest || Date.parse(item.createdAt) > Date.parse(latest.createdAt)
        ? item
        : latest,
    undefined,
  );
  if (newest?.status === "failed") return { label: "发送失败", tone: "danger" };
  if (newest || (turn && items.some((item) => Date.parse(item.ts) > boundary)))
    return { label: "确认中", tone: "neutral" };
  if (turn?.outcome === "failed") return { label: "执行失败", tone: "danger" };
  if (turn?.outcome === "waiting")
    return { label: "等待补充", tone: "warning" };
  if (
    turn?.outcome === "confirming" ||
    (turn && !["none", "synced"].includes(turn.artifactState))
  )
    return { label: "确认中", tone: "neutral" };
  if (turn?.outcome === "completed")
    return { label: "本轮完成", tone: "success" };
  if (session.upstreamReady === false)
    return { label: "准备中", tone: "neutral" };
  return { label: "待开始", tone: "neutral" };
}

export function canStopTask(session: SessionSummary): boolean {
  return (
    session.upstreamReady === true &&
    session.deletionState === "none" &&
    ["initializing", "upgrading", "running", "rescheduled"].includes(
      session.status,
    )
  );
}

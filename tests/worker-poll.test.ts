import { describe, expect, it, vi } from "vitest";
import { runProductionWorkerPoll } from "../apps/worker/src/poll.js";

describe("production worker poll", () => {
  it("executes artifact deletion even when another processor fails", async () => {
    const earlier = {
      runOnce: vi.fn(async () => {
        throw new Error("reconciliation unavailable");
      }),
    };
    const artifactDeletion = {
      runOnce: vi.fn(async () => 1),
    };
    const artifactCleanup = {
      runOnce: vi.fn(async () => 1),
    };
    const session = { runOnce: vi.fn(async () => 0) };
    const sessionDeletion = { runOnce: vi.fn(async () => 1) };
    const uploadCleanup = { runOnce: vi.fn(async () => 0) };
    const reportError = vi.fn();

    await runProductionWorkerPoll(
      {
        personalAgent: earlier,
        session,
        sessionDeletion,
        uploadCleanup,
        artifactDeletion,
        artifactCleanup,
      },
      reportError,
    );

    expect(earlier.runOnce).toHaveBeenCalledOnce();
    expect(session.runOnce).toHaveBeenCalledOnce();
    expect(sessionDeletion.runOnce).toHaveBeenCalledOnce();
    expect(uploadCleanup.runOnce).toHaveBeenCalledOnce();
    expect(artifactDeletion.runOnce).toHaveBeenCalledOnce();
    expect(artifactCleanup.runOnce).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(
      "Worker processor poll failed",
      expect.objectContaining({ message: "reconciliation unavailable" }),
    );
  });
});

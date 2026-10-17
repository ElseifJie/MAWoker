import { describe, expect, it, vi } from "vitest";
import {
  HttpArkGateway,
  type ArkEvent,
} from "../packages/ark-client/src/index.js";
import {
  observeSessionTurns,
  SessionDeliveryService,
} from "../packages/domain/src/session-delivery.js";

const time = new Date("2026-10-13T00:00:00Z");
const event = (
  id: string,
  type: string,
  data: Record<string, unknown>,
  offset = 0,
): ArkEvent => ({
  id,
  type,
  data,
  createdAt: new Date(time.getTime() + offset).toISOString(),
});
const history = [
  event("initial-idle", "session.status_idle", {}),
  event("input", "user.message", { content: "do task" }, 100),
  event("answer", "agent.message", { content: "Completed." }, 200),
  event(
    "end",
    "session.status_idle",
    { stop_reason: { type: "end_turn" } },
    300,
  ),
];

describe("turn delivery observations", () => {
  it("requires a processed input, response and explicit session-level end_turn", () => {
    expect(observeSessionTurns(history)).toEqual([
      expect.objectContaining({
        boundaryEventId: "end",
        inputEventId: "input",
        outcome: "completed",
        summary: "Completed.",
      }),
    ]);
    expect(observeSessionTurns(history.slice(0, -1))).toEqual([]);
    expect(
      observeSessionTurns([
        history[0]!,
        history[1]!,
        history[2]!,
        event("thread", "session.thread_status_idle", {
          stop_reason: { type: "end_turn" },
        }),
      ]),
    ).toEqual([]);
  });

  it("keeps an idle with no stop reason neutral and waiting or exhausted separate", () => {
    for (const [reason, outcome] of [
      [undefined, "confirming"],
      ["requires_action", "waiting"],
      ["retries_exhausted", "failed"],
    ] as const) {
      const observed = observeSessionTurns([
        history[1]!,
        event(
          "end",
          "session.status_idle",
          reason ? { stop_reason: { type: reason } } : {},
          300,
        ),
      ]);
      expect(observed[0]?.outcome).toBe(outcome);
    }
  });

  it("deduplicates boundaries, preserves timestamp ties and redacts result summaries", () => {
    const events = [
      event("zzz-input", "user.message", { content: "task" }),
      event("aaa-answer", "agent.message", {
        content: "token: secret-key /mnt/data/report.xlsx",
      }),
      event("boundary", "session.status_idle", {
        stop_reason: { type: "end_turn" },
      }),
    ];
    const observed = observeSessionTurns([...events, events[2]!]);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.summary).not.toContain("secret-key");
    expect(observed[0]?.expectedNames).toEqual(["report.xlsx"]);
  });

  it("does not classify end_turn without a reply as delivered", () => {
    expect(observeSessionTurns([history[1]!, history[3]!])[0]?.outcome).toBe(
      "confirming",
    );
  });

  it("keeps reported output names for the current mounted output directory", () => {
    const observed = observeSessionTurns([
      history[1]!,
      event(
        "answer",
        "agent.message",
        { content: "文件在 /mnt/session/outputs/报告.xlsx。" },
        200,
      ),
      history[3]!,
    ]);
    expect(observed[0]?.expectedNames).toEqual(["报告.xlsx"]);
  });

  it("ends a display-wrapped path at the tag instead of absorbing it", () => {
    const observed = observeSessionTurns([
      history[1]!,
      event(
        "answer",
        "agent.message",
        {
          content:
            "完整长图在这里：\n\n<display>/mnt/session/outputs/qwen-n1-2026/qwen-n1-longimage.jpg</display>",
        },
        200,
      ),
      history[3]!,
    ]);
    // Absorbing `</display` made the derived name "display", which no real
    // file matches, so the turn settled as ARTIFACTS_NOT_VISIBLE.
    expect(observed[0]?.expectedNames).toEqual(["qwen-n1-longimage.jpg"]);
  });

  it("retains earlier file declarations when the final response contains only a summary", () => {
    const observed = observeSessionTurns([
      history[1]!,
      event(
        "file",
        "agent.message",
        { content: "/mnt/session/outputs/report.xlsx" },
        200,
      ),
      event("summary", "agent.message", { content: "Done." }, 250),
      history[3]!,
    ]);
    expect(observed[0]?.expectedNames).toEqual(["report.xlsx"]);
  });
});

function fixture() {
  const turn = {
    id: "turn",
    ownerUserId: "owner",
    sessionId: "session",
    boundaryEventId: "end",
    inputEventId: "input",
    outcome: "completed" as const,
    summary: "Completed.",
    expectedNames: [] as string[],
    startedAt: time,
    endedAt: time,
    artifactState: "pending" as const,
    artifactIds: [] as string[],
    usageState: "pending" as const,
    errorCode: null,
    retryUntil: new Date(time.getTime() + 300_000),
    createdAt: time,
    updatedAt: time,
  };
  const repository = {
    listDiscoveryCandidates: vi.fn(async () => [
      { ownerUserId: "owner", sessionId: "session", arkSessionId: "upstream" },
    ]),
    markDiscoveryChecked: vi.fn(async () => {}),
    recordObservations: vi.fn(async () => {}),
    claimSync: vi.fn(async () => ({
      turn,
      arkSessionId: "upstream",
      blocked: false,
    })),
    finishSync: vi.fn(async () => true),
  };
  const sessions = { reconcileHistory: vi.fn(async () => history) };
  const ark = {
    getSession: vi.fn(async () => ({ status: "idle" })),
    listArtifacts: vi.fn(async () => []),
  };
  const artifacts = { syncSession: vi.fn(async () => []) };
  const service = new SessionDeliveryService({
    repository,
    sessions,
    ark: ark as never,
    artifacts,
    now: () => new Date(time.getTime() + 60_000),
    emptyGraceMs: 30_000,
  });
  const context = {
    userId: "owner",
    workerId: "worker",
    leaseGeneration: 1,
    requestId: "test",
  };
  return { turn, repository, sessions, ark, artifacts, service, context };
}

describe("background turn delivery", () => {
  it("finishes an expired text-only turn without a sync error for the live JSON null Files response", async () => {
    const f = fixture();
    f.turn.retryUntil = new Date(time.getTime() - 1);
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example",
      apiKey: "test",
      fetch: vi.fn().mockResolvedValue(Response.json(null)),
      maxAttempts: 1,
    });
    f.ark.listArtifacts.mockImplementation(() =>
      gateway.listArtifacts("upstream"),
    );
    await expect(
      f.service.syncArtifacts("turn", f.context),
    ).resolves.toBeUndefined();
    expect(f.repository.finishSync).toHaveBeenCalledWith(
      "owner",
      "turn",
      "worker",
      1,
      expect.objectContaining({
        artifactState: "synced",
        artifactIds: [],
        errorCode: null,
      }),
    );
  });

  it("bounds discovery even if the history client ignores cancellation", async () => {
    const f = fixture();
    f.sessions.reconcileHistory.mockImplementationOnce(
      () => new Promise(() => {}),
    );
    const service = new SessionDeliveryService({
      repository: f.repository,
      sessions: f.sessions,
      ark: f.ark as never,
      artifacts: f.artifacts,
      timeoutMs: 20,
      now: () => time,
    });
    await expect(service.discoverOnce()).resolves.toBe(1);
    expect(f.repository.recordObservations).not.toHaveBeenCalled();
  });

  it("records offline results only after durable history reconciliation and status verification", async () => {
    const f = fixture();
    await f.service.discoverOnce();
    expect(f.repository.recordObservations).toHaveBeenCalledWith(
      "owner",
      "session",
      expect.arrayContaining([
        expect.objectContaining({
          outcome: "completed",
          boundaryEventId: "end",
        }),
      ]),
      expect.objectContaining({ upstreamStatus: "idle" }),
    );
    f.sessions.reconcileHistory.mockRejectedValueOnce(
      new Error("persistence failed"),
    );
    f.repository.recordObservations.mockClear();
    await f.service.discoverOnce();
    expect(f.repository.recordObservations).not.toHaveBeenCalled();
    expect(f.repository.markDiscoveryChecked).toHaveBeenLastCalledWith(
      "owner",
      "session",
      expect.any(Date),
      false,
      expect.any(AbortSignal),
    );
  });

  it("completes a text-only result after the visibility grace period", async () => {
    const f = fixture();
    await expect(
      f.service.syncArtifacts("turn", f.context),
    ).rejects.toMatchObject({ code: "ARTIFACT_SYNC_PENDING" });
    expect(f.repository.finishSync).toHaveBeenCalledWith(
      "owner",
      "turn",
      "worker",
      1,
      expect.objectContaining({ artifactState: "synced", artifactIds: [] }),
    );
  });

  it("continues checking text-only completions for files without a declared path", async () => {
    const f = fixture();
    f.repository.claimSync.mockResolvedValueOnce({
      turn: { ...f.turn, artifactState: "synced" },
      blocked: false,
      arkSessionId: "upstream",
    } as never);
    f.artifacts.syncSession.mockResolvedValueOnce([
      {
        id: "late-local",
        arkFileId: "late",
        name: "report.txt",
        generatedAt: new Date(time.getTime() + 1000),
        deletionState: "none",
      },
    ] as never);
    await expect(
      f.service.syncArtifacts("turn", f.context),
    ).rejects.toMatchObject({ code: "ARTIFACT_SYNC_PENDING" });
    expect(f.repository.finishSync).toHaveBeenLastCalledWith(
      "owner",
      "turn",
      "worker",
      1,
      expect.objectContaining({
        artifactState: "synced",
        artifactIds: ["late-local"],
      }),
    );
  });

  it("bounds synchronization when the upstream ignores cancellation", async () => {
    const f = fixture();
    f.ark.getSession.mockImplementationOnce(() => new Promise(() => {}));
    const service = new SessionDeliveryService({
      repository: f.repository,
      sessions: f.sessions,
      ark: f.ark as never,
      artifacts: f.artifacts,
      timeoutMs: 20,
      now: () => time,
    });
    await expect(
      service.syncArtifacts("turn", f.context),
    ).rejects.toMatchObject({ code: "ARTIFACT_SYNC_PENDING" });
    expect(f.repository.finishSync).toHaveBeenCalledWith(
      "owner",
      "turn",
      "worker",
      1,
      expect.objectContaining({ artifactState: "pending" }),
    );
  });

  it("preserves delivered references if a late-file check has an empty inventory", async () => {
    const f = fixture();
    f.repository.claimSync.mockResolvedValueOnce({
      turn: {
        ...f.turn,
        artifactState: "synced",
        artifactIds: ["already-copied"],
      },
      blocked: false,
      arkSessionId: "upstream",
    } as never);
    await expect(
      f.service.syncArtifacts("turn", f.context),
    ).rejects.toMatchObject({ code: "ARTIFACT_SYNC_PENDING" });
    expect(f.repository.finishSync).toHaveBeenLastCalledWith(
      "owner",
      "turn",
      "worker",
      1,
      expect.objectContaining({
        artifactState: "synced",
        artifactIds: ["already-copied"],
      }),
    );
  });

  it.each(["running", "read-failure"])(
    "does not revoke delivery when optional late monitoring sees %s",
    async (mode) => {
      const f = fixture();
      const completed = {
        ...f.turn,
        artifactState: "synced",
        artifactIds: ["copied"],
        retryUntil: time,
      };
      f.repository.claimSync.mockResolvedValueOnce({
        turn: completed,
        blocked: false,
        arkSessionId: "upstream",
        nextStartedAt: new Date(time.getTime() + 1000),
      } as never);
      if (mode === "running")
        f.ark.getSession.mockResolvedValueOnce({ status: "running" });
      else
        f.ark.getSession.mockRejectedValueOnce(
          new Error("temporary upstream outage"),
        );
      await expect(
        f.service.syncArtifacts("turn", f.context),
      ).resolves.toBeUndefined();
      expect(f.repository.finishSync).toHaveBeenLastCalledWith(
        "owner",
        "turn",
        "worker",
        1,
        expect.objectContaining({
          artifactState: "synced",
          artifactIds: ["copied"],
          errorCode: null,
        }),
      );
    },
  );

  it("retries reported files that arrive late and persists a recoverable failure after the window", async () => {
    const f = fixture();
    f.turn.expectedNames.push("report.xlsx");
    await expect(
      f.service.syncArtifacts("turn", f.context),
    ).rejects.toMatchObject({ code: "ARTIFACT_SYNC_PENDING" });
    expect(f.repository.finishSync).toHaveBeenLastCalledWith(
      "owner",
      "turn",
      "worker",
      1,
      expect.objectContaining({
        artifactState: "pending",
        errorCode: "ARTIFACTS_NOT_VISIBLE",
      }),
    );
    f.turn.retryUntil = time;
    await expect(
      f.service.syncArtifacts("turn", f.context),
    ).resolves.toBeUndefined();
    expect(f.repository.finishSync).toHaveBeenLastCalledWith(
      "owner",
      "turn",
      "worker",
      1,
      expect.objectContaining({
        artifactState: "failed",
        errorCode: "ARTIFACTS_NOT_VISIBLE",
      }),
    );
  });

  it("does not sync a fenced, deleted or already synced round", async () => {
    const f = fixture();
    f.repository.claimSync.mockResolvedValueOnce(undefined as never);
    await expect(
      f.service.syncArtifacts("turn", f.context),
    ).rejects.toMatchObject({ code: "DELIVERY_LEASE_LOST" });
    expect(f.artifacts.syncSession).not.toHaveBeenCalled();
    f.repository.claimSync.mockResolvedValueOnce({
      turn: {
        ...f.turn,
        artifactState: "synced",
        expectedNames: ["known.txt"],
      },
      blocked: false,
      arkSessionId: "upstream",
    } as never);
    await f.service.syncArtifacts("turn", f.context);
    expect(f.artifacts.syncSession).not.toHaveBeenCalled();
  });

  it("keeps unknown submissions and actively running sessions from producing completion notifications", async () => {
    const f = fixture();
    f.repository.claimSync.mockResolvedValueOnce({
      turn: f.turn,
      blocked: true,
      arkSessionId: "upstream",
    });
    await expect(
      f.service.syncArtifacts("turn", f.context),
    ).rejects.toMatchObject({ code: "ARTIFACT_SYNC_PENDING" });
    expect(f.artifacts.syncSession).not.toHaveBeenCalled();
    expect(f.repository.finishSync).not.toHaveBeenCalled();
  });

  it("rejects stale acknowledgement instead of marking a job successful", async () => {
    const f = fixture();
    f.repository.finishSync.mockResolvedValueOnce(false);
    await expect(
      f.service.syncArtifacts("turn", f.context),
    ).rejects.toMatchObject({ code: "DELIVERY_LEASE_LOST" });
  });

  it("does not use a later turn's same-named result to satisfy an earlier missing file", async () => {
    const f = fixture();
    f.turn.expectedNames = ["report.xlsx"];
    f.repository.claimSync.mockResolvedValueOnce({
      turn: f.turn,
      blocked: false,
      arkSessionId: "upstream",
      nextStartedAt: new Date(time.getTime() + 1000),
    } as never);
    f.ark.listArtifacts.mockResolvedValueOnce([
      {
        id: "later",
        name: "report.xlsx",
        sessionId: "upstream",
        createdAt: new Date(time.getTime() + 2000).toISOString(),
        tos: { bucket: "b", objectKey: "k" },
      },
    ] as never);
    f.artifacts.syncSession.mockResolvedValueOnce([
      {
        id: "later-local",
        arkFileId: "later",
        name: "report.xlsx",
        generatedAt: new Date(time.getTime() + 2000),
        deletionState: "none",
      },
    ] as never);
    await expect(
      f.service.syncArtifacts("turn", f.context),
    ).rejects.toMatchObject({ code: "ARTIFACT_SYNC_PENDING" });
    expect(f.repository.finishSync).toHaveBeenLastCalledWith(
      "owner",
      "turn",
      "worker",
      1,
      expect.objectContaining({ artifactIds: [], artifactState: "pending" }),
    );
    expect(f.artifacts.syncSession).toHaveBeenCalledWith(
      "session",
      expect.objectContaining({ sourceFileIds: [] }),
    );
  });

  it("allows an explicitly declared edit of an older file only in the latest turn", async () => {
    const f = fixture();
    f.turn.expectedNames = ["report.xlsx"];
    const file = {
      id: "older",
      name: "report.xlsx",
      sessionId: "upstream",
      createdAt: new Date(time.getTime() - 2000).toISOString(),
      tos: { bucket: "b", objectKey: "k" },
    };
    f.ark.listArtifacts.mockResolvedValue([file] as never);
    f.artifacts.syncSession.mockResolvedValue([
      {
        id: "older-local",
        arkFileId: "older",
        name: "report.xlsx",
        generatedAt: new Date(file.createdAt),
        deletionState: "none",
      },
    ] as never);
    await expect(
      f.service.syncArtifacts("turn", f.context),
    ).resolves.toBeUndefined();
    expect(f.repository.finishSync).toHaveBeenLastCalledWith(
      "owner",
      "turn",
      "worker",
      1,
      expect.objectContaining({
        artifactIds: ["older-local"],
        artifactState: "synced",
      }),
    );
  });
});

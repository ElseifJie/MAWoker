import { describe, expect, it, vi } from "vitest";
import { InMemoryArkGateway } from "../packages/ark-client/src/index.js";
import {
  MemoryService,
  type MemoryState,
  type MemoryRepository,
} from "../packages/domain/src/memory.js";

function setup() {
  const states = new Map<string, MemoryState>();
  const sessions: Array<{
    id: string;
    arkSessionId: string;
    memoryStoreId: string | null;
    pending: boolean;
    userId: string;
  }> = [];
  const repository: MemoryRepository = {
    async reserve(userId) {
      const existing = states.get(userId);
      if (existing) return { created: false, state: structuredClone(existing) };
      const state: MemoryState = {
        userId,
        revision: 0,
        status: "provisioning",
        storeId: null,
        policyEpoch: 0,
        protectedPaths: [],
        revokedPaths: [],
        autoDream: true,
        run: null,
        lastMonitorAt: 0,
        lastCompactAt: 0,
      };
      states.set(userId, structuredClone(state));
      return { created: true, state };
    },
    async get(userId) {
      return structuredClone(states.get(userId));
    },
    async meta(userId) {
      if (!states.has(userId)) return undefined;
      return {
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
    },
    async save(userId, revision, state) {
      if (states.get(userId)?.revision !== revision)
        throw new Error("CAS conflict");
      states.set(userId, structuredClone({ ...state, revision: revision + 1 }));
    },
    async list() {
      return structuredClone([...states.values()]);
    },
    async sessions(userId) {
      return sessions.filter((s) => s.userId === userId);
    },
    async gate(userId) {
      if (states.get(userId)?.status !== "active")
        throw new Error("MEMORY_BUSY");
    },
  };
  const ark = new InMemoryArkGateway();
  let clock = 1_000_000;
  const service = new MemoryService({
    repository,
    ark,
    modelId: "model-a",
    now: () => clock,
  });
  return {
    service,
    repository,
    states,
    ark,
    sessions,
    setNow: (value: number) => (clock = value),
  };
}

async function finish(service: MemoryService, userId: string, ticks = 30) {
  for (let i = 0; i < ticks; i++) {
    const state = await service.status(userId);
    if (
      !state.run ||
      ["completed", "failed", "repairing"].includes(state.run.stage)
    )
      return state;
    await service.advance(userId);
  }
  return service.status(userId);
}

async function reachPolling(
  harness: ReturnType<typeof setup>,
  options: { trailingThreadEvent?: boolean } = {},
) {
  const { service, ark, sessions } = harness;
  const store = await service.ensure("a");
  const agent = await ark.createAgent({
    name: "A",
    description: "",
    modelId: "model-a",
    systemPrompt: "",
  });
  const session = await ark.createSession({
    agentId: agent.id,
    agentVersion: 1,
    environmentId: "env",
    resources: [
      { type: "memory_store", memoryStoreId: store, access: "read_write" },
    ],
  });
  sessions.push({
    id: "local",
    arkSessionId: session.id,
    memoryStoreId: store,
    pending: false,
    userId: "a",
  });
  ark.emitEvent(session.id, {
    type: "agent.message",
    data: { content: "done" },
  });
  ark.emitEvent(session.id, {
    type: "session.status_idle",
    data: { stop_reason: { type: "end_turn" } },
  });
  if (options.trailingThreadEvent)
    ark.emitEvent(session.id, {
      type: "session.thread_status_idle",
      data: {},
    });
  await service.dream("a");
  await service.advance("a");
  let guard = 12;
  while (
    ((await service.status("a")).run?.stage ?? "") !== "polling" &&
    guard-- > 0
  )
    await service.advance("a");
  const state = await service.status("a");
  if (state.run?.stage !== "polling") throw new Error("polling not reached");
  return state;
}

describe("personal memory coordinator", () => {
  it("verifies an applied write using the remote hash when readback omits trailing whitespace", async () => {
    const { service, ark } = setup();
    await service.ensure("a");
    const original = ark.getMemory.bind(ark);
    vi.spyOn(ark, "getMemory").mockImplementation(async (...args) => {
      const entry = await original(...args);
      return { ...entry, content: entry.content.trimEnd() };
    });
    await service.write("a", { path: "/memories/new.md", content: "new\n" });
    const finished = await finish(service, "a");
    expect(finished.status).toBe("active");
    expect(finished.run?.stage).toBe("completed");
    expect(
      ark.calls.filter(
        (c) =>
          c.operation === "createMemory" &&
          (c.input as { path?: string }).path === "/memories/new.md",
      ),
    ).toHaveLength(1);
  });

  it("recovers by remote hash without replay and leaves quarantined revisions unchanged", async () => {
    const { service, ark, states } = setup();
    const store = await service.ensure("a");
    await service.write("a", {
      path: "/memories/new.md",
      content: "late success\n",
    });
    const frozen = states.get("a")!;
    frozen.run!.steps[0].status = "sending";
    frozen.run!.stage = "repairing";
    frozen.run!.error = "original verification failure";
    frozen.status = "repairing";
    const revision = frozen.revision;
    await service.advance("a");
    await service.runOnce();
    expect(states.get("a")!.revision).toBe(revision);
    expect(states.get("a")!.run!.error).toBe("original verification failure");
    await ark.createMemory(store, {
      path: "/memories/new.md",
      content: "late success\n",
    });
    const original = ark.listMemories.bind(ark);
    vi.spyOn(ark, "listMemories").mockImplementation(async (...args) =>
      (await original(...args)).map((entry) => ({
        ...entry,
        content: entry.content.trimEnd(),
      })),
    );
    const calls = ark.calls.filter(
      (c) => c.operation === "createMemory",
    ).length;
    await service.recover("a");
    await finish(service, "a");
    expect((await service.status("a")).status).toBe("active");
    expect(
      ark.calls.filter((c) => c.operation === "createMemory"),
    ).toHaveLength(calls);
  });

  it("does not accept a matching readback body when its remote hash proves different stored content", async () => {
    const { service, ark } = setup();
    await service.ensure("a");
    const original = ark.getMemory.bind(ark);
    vi.spyOn(ark, "getMemory").mockImplementation(async (...args) => ({
      ...(await original(...args)),
      contentSha256: "0".repeat(64),
    }));
    await service.write("a", { path: "/memories/new.md", content: "new" });
    expect((await finish(service, "a")).status).toBe("repairing");
    const list = ark.listMemories.bind(ark);
    vi.spyOn(ark, "listMemories").mockImplementation(async (...args) =>
      (await list(...args)).map((entry) => ({
        ...entry,
        contentSha256: "0".repeat(64),
      })),
    );
    await expect(service.recover("a")).rejects.toMatchObject({
      code: "MEMORY_REPAIR_REQUIRED",
    });
  });

  it("reuses one fixed Store per user and isolates all reads", async () => {
    const { service } = setup();
    const a = await service.ensure("a");
    expect(await service.ensure("a")).toBe(a);
    expect(await service.ensure("b")).not.toBe(a);
    await service.write("a", {
      path: "/memories/preferences/workflow.md",
      content: "分步骤执行",
    });
    await finish(service, "a");
    expect(
      (await service.list("a")).entries.some((e) => e.content === "分步骤执行"),
    ).toBe(true);
    expect(
      (await service.list("b")).entries.some((e) => e.content === "分步骤执行"),
    ).toBe(false);
  });
  it("checks optimistic hashes and persists protection", async () => {
    const { service } = setup();
    await service.ensure("a");
    await expect(
      service.write("a", {
        path: "/memories/profile.md",
        content: "change",
        expectedHash: "stale",
      }),
    ).rejects.toThrow();
    await service.protect("a", "/memories/profile.md", true);
    expect((await service.status("a")).protectedPaths).toContain(
      "/memories/profile.md",
    );
  });
  it("waits for actual end_turn and does not treat requires_action as stopped", async () => {
    const { service, ark, sessions } = setup();
    const store = await service.ensure("a");
    const agent = await ark.createAgent({
      name: "A",
      description: "",
      modelId: "model-a",
      systemPrompt: "",
    });
    const session = await ark.createSession({
      agentId: agent.id,
      agentVersion: 1,
      environmentId: "env",
      resources: [
        { type: "memory_store", memoryStoreId: store, access: "read_write" },
      ],
    });
    sessions.push({
      id: "local",
      arkSessionId: session.id,
      memoryStoreId: store,
      pending: false,
      userId: "a",
    });
    ark.emitEvent(session.id, {
      type: "session.status_idle",
      data: { stop_reason: { type: "requires_action" } },
    });
    await service.compress("a");
    await service.advance("a");
    expect((await service.status("a")).run?.stage).toBe("queued");
    ark.emitEvent(session.id, {
      type: "session.status_idle",
      data: { stop_reason: { type: "end_turn" } },
    });
    expect((await finish(service, "a")).run?.stage).toBe("completed");
  });
  it("quarantines unknown write outcomes and never blindly replays", async () => {
    const { service, ark } = setup();
    await service.ensure("a");
    await service.write("a", { path: "/memories/new.md", content: "new" });
    ark.failNext("createMemory", "connection_failure");
    await finish(service, "a");
    expect((await service.status("a")).status).toBe("repairing");
    const count = ark.calls.filter(
      (c) => c.operation === "createMemory",
    ).length;
    await service.advance("a");
    expect(
      ark.calls.filter((c) => c.operation === "createMemory"),
    ).toHaveLength(count);
  });
  it("cleans duplicates without unrelated Dream sessions and preserves protected memories", async () => {
    const { service, ark } = setup();
    const store = await service.ensure("a");
    await ark.createMemory(store, {
      path: "/episodes/digest/a.md",
      content: "same",
    });
    await ark.createMemory(store, {
      path: "/episodes/digest/b.md",
      content: "same",
    });
    await service.protect("a", "/episodes/digest/b.md", true);
    await service.compress("a");
    await finish(service, "a");
    const paths = (await service.list("a")).entries.map((e) => e.path);
    expect(paths).toContain("/episodes/digest/b.md");
    expect(paths).not.toContain("/episodes/digest/a.md");
    expect(ark.calls.some((c) => c.operation === "createDream")).toBe(false);
  });
  it("recovers an observed successful write without submitting it again", async () => {
    const { service, ark, states } = setup();
    const store = await service.ensure("a");
    await service.write("a", {
      path: "/memories/new.md",
      content: "late success",
    });
    await service.advance("a");
    const state = states.get("a")!;
    state.run!.steps[0]!.status = "sending";
    state.run!.stage = "repairing";
    state.status = "repairing";
    await ark.createMemory(store, {
      path: "/memories/new.md",
      content: "late success",
    });
    const creates = ark.calls.filter(
      (c) => c.operation === "createMemory",
    ).length;
    await service.recover("a");
    await finish(service, "a");
    expect((await service.status("a")).status).toBe("active");
    expect(
      ark.calls.filter((c) => c.operation === "createMemory"),
    ).toHaveLength(creates);
  });
  it("processes queued users beyond the first twenty fairly", async () => {
    const { service, states } = setup();
    for (let i = 0; i < 21; i++) {
      await service.ensure(`user${i}`);
      states.get(`user${i}`)!.lastMonitorAt = 1_000_000;
    }
    await service.compress("user20");
    for (let i = 0; i < 8; i++) await service.runOnce();
    expect((await service.status("user20")).run?.stage).toBe("completed");
  });
  it("never cleans up the fixed store if Dream returns it as an invalid output", async () => {
    const { service, ark, states } = setup();
    const store = await service.ensure("a");
    const dream = await ark
      .createDream({
        memoryStoreId: store,
        sessionIds: ["session"],
        modelId: "model-a",
        instructions: "",
      })
      .catch(() => null);
    // Polling is hydrated as a durable run to isolate malicious upstream output.
    const state = states.get("a")!;
    state.run = {
      kind: "dream",
      stage: "polling",
      epoch: 0,
      baseline: [],
      snapshotId: null,
      candidateId: null,
      dreamId: dream?.id ?? "dream-invalid",
      sources: [],
      steps: [],
      error: null,
      before: null,
      after: null,
      pendingOperation: null,
    };
    const get = ark.getDream.bind(ark);
    ark.getDream = async (id) =>
      id === state.run!.dreamId
        ? { id, status: "completed", outputMemoryStoreId: store, usage: null }
        : get(id);
    await service.advance("a");
    await service.advance("a");
    expect((await ark.getMemoryStore(store)).id).toBe(store);
    expect((await service.status("a")).run?.stage).toBe("failed");
  });
  it("rejects unsupported candidate claims and retains all prior facts", async () => {
    const { service, ark, sessions } = setup();
    const store = await service.ensure("a");
    const agent = await ark.createAgent({
      name: "A",
      description: "",
      modelId: "model-a",
      systemPrompt: "",
    });
    const session = await ark.createSession({
      agentId: agent.id,
      agentVersion: 1,
      environmentId: "env",
      resources: [
        { type: "memory_store", memoryStoreId: store, access: "read_write" },
      ],
    });
    ark.emitEvent(session.id, {
      type: "user.message",
      data: { content: "not allergic to penicillin" },
    });
    ark.emitEvent(session.id, {
      type: "session.status_idle",
      data: { stop_reason: { type: "end_turn" } },
    });
    sessions.push({
      id: "local",
      arkSessionId: session.id,
      memoryStoreId: store,
      pending: false,
      userId: "a",
    });
    await service.dream("a");
    for (
      let i = 0;
      i < 12 && (await service.status("a")).run?.stage !== "polling";
      i++
    )
      await service.advance("a");
    const candidate = await ark.createMemoryStore({ name: "hostile" });
    await ark.createMemory(candidate.id, {
      path: "/memories/profile.md",
      content: `sourceSessionId: ${session.id}\nUse concise answers`,
    });
    await ark.createMemory(candidate.id, {
      path: "/memories/new.md",
      content: `sourceSessionId: ${session.id}\nallergic to penicillin`,
    });
    ark.setDreamResult((await service.status("a")).run!.dreamId!, candidate.id);
    await finish(service, "a");
    const entries = (await service.list("a")).entries;
    expect(
      entries.find((e) => e.path === "/memories/profile.md")!.content,
    ).toContain("尚未记录");
    expect(entries.some((e) => e.path === "/memories/new.md")).toBe(false);
    await service.remove("a", "/memories/profile.md");
    await finish(service, "a");
    ark.emitEvent(session.id, {
      type: "user.message",
      data: { content: "Use concise answers" },
    });
    ark.emitEvent(session.id, {
      type: "session.status_idle",
      data: { stop_reason: { type: "end_turn" } },
    });
    await service.dream("a");
    await finish(service, "a");
    expect((await service.status("a")).run?.stage).toBe("failed");
    expect((await service.status("a")).excludedSourceIds).toContain(session.id);
  });
  it("uses targeted reads rather than a full inventory per application step", async () => {
    const { service, ark } = setup();
    const store = await service.ensure("a");
    for (let i = 0; i < 30; i++)
      await ark.createMemory(store, {
        path: `/episodes/digest/topic/${i}.md`,
        content: `fact ${i}`,
      });
    await service.compress("a");
    await service.advance("a");
    const lists = ark.calls.filter(
      (c) => c.operation === "listMemories",
    ).length;
    await service.advance("a");
    expect(
      ark.calls.filter((c) => c.operation === "listMemories"),
    ).toHaveLength(lists);
    expect(
      ark.calls.filter((c) => c.operation === "updateMemory"),
    ).toHaveLength(1);
  });
  it("only marks successful Dream sources summarized", async () => {
    const { service, states } = setup();
    await service.ensure("a");
    await service.compress("a");
    const state = states.get("a")!;
    state.run!.stage = "cleanup";
    state.run!.sources = [
      { id: "s", fingerprint: "not-dream", text: "source" },
    ];
    await service.advance("a");
    expect((await service.status("a")).summarizedSources ?? []).not.toContain(
      "not-dream",
    );
  });
  it("does not re-dream a summarized session whose tool inputs merely reorder", async () => {
    const { service, ark, sessions } = setup();
    const store = await service.ensure("a");
    const agent = await ark.createAgent({
      name: "A",
      description: "",
      modelId: "model-a",
      systemPrompt: "",
    });
    const session = await ark.createSession({
      agentId: agent.id,
      agentVersion: 1,
      environmentId: "env",
      resources: [
        { type: "memory_store", memoryStoreId: store, access: "read_write" },
      ],
    });
    ark.emitEvent(session.id, {
      type: "agent.tool_use",
      data: {
        input: { description: "Check current date", command: "date '+%Y'" },
      },
    });
    ark.emitEvent(session.id, {
      type: "agent.message",
      data: { content: "done" },
    });
    ark.emitEvent(session.id, {
      type: "session.status_idle",
      data: { stop_reason: { type: "end_turn" } },
    });
    sessions.push({
      id: "local",
      arkSessionId: session.id,
      memoryStoreId: store,
      pending: false,
      userId: "a",
    });
    await service.dream("a");
    let guard = 12;
    while (
      ((await service.status("a")).run?.stage ?? "") !== "polling" &&
      guard-- > 0
    )
      await service.advance("a");
    const polling = await service.status("a");
    const candidate = await ark.createMemoryStore({ name: "candidate" });
    ark.setDreamResult(polling.run!.dreamId!, candidate.id);
    const finished = await finish(service, "a");
    expect(finished.run?.stage).toBe("completed");
    expect(finished.summarizedSources).toHaveLength(1);

    // The upstream events API re-serializes tool-call input maps on every
    // request, so raw JSON.stringify fingerprints changed per fetch and used
    // to re-plan an identical Dream on every monitor pass.
    const original = ark.listEvents.bind(ark);
    ark.listEvents = async (sessionId, options) => {
      const events = await original(sessionId, options);
      return events.map((event) => {
        const input = (event.data as { input?: object }).input;
        return input
          ? {
              ...event,
              data: {
                ...event.data,
                input: Object.fromEntries(Object.entries(input).reverse()),
              },
            }
          : event;
      });
    };

    await service.runOnce();
    const after = await service.status("a");
    expect(after.run?.stage).toBe("completed");
  });
  it("polls Dream, preserves intervening writes and keeps the fixed binding", async () => {
    const { service, ark, sessions } = setup();
    const store = await service.ensure("a");
    const agent = await ark.createAgent({
      name: "A",
      description: "",
      modelId: "model-a",
      systemPrompt: "",
    });
    const session = await ark.createSession({
      agentId: agent.id,
      agentVersion: 1,
      environmentId: "env",
      resources: [
        { type: "memory_store", memoryStoreId: store, access: "read_write" },
      ],
    });
    ark.emitEvent(session.id, {
      type: "agent.message",
      data: { content: "分步骤执行" },
    });
    ark.emitEvent(session.id, {
      type: "session.status_idle",
      data: { stop_reason: { type: "end_turn" } },
    });
    sessions.push({
      id: "local",
      arkSessionId: session.id,
      memoryStoreId: store,
      pending: false,
      userId: "a",
    });
    await service.dream("a");
    for (
      let i = 0;
      i < 12 && (await service.status("a")).run?.stage !== "polling";
      i++
    )
      await service.advance("a");
    expect((await service.status("a")).status).toBe("active");
    await service.advance("a");
    expect((await service.status("a")).run?.stage).toBe("polling");
    await ark.updateMemory(
      store,
      (await ark.listMemories(store)).find(
        (e) => e.path === "/memories/profile.md",
      )!.id,
      { path: "/memories/profile.md", content: "user correction" },
    );
    const candidate = await ark.createMemoryStore({ name: "candidate" });
    await ark.createMemory(candidate.id, {
      path: "/memories/profile.md",
      content: "dream changed",
    });
    await ark.createMemory(candidate.id, {
      path: "/memories/preferences/workflow.md",
      content: `sourceSessionId: ${session.id}\n分步骤执行`,
    });
    const state = await service.status("a");
    ark.setDreamResult(state.run!.dreamId!, candidate.id);
    await finish(service, "a");
    expect(await service.ensure("a")).toBe(store);
    const entries = (await service.list("a")).entries;
    expect(
      entries.find((e) => e.path === "/memories/profile.md")?.content,
    ).toBe("user correction");
    expect(
      entries.some((e) => e.path === "/memories/preferences/workflow.md"),
    ).toBe(true);
    expect((await service.status("a")).run?.stage).toBe("completed");
  });
  it("reconciles interrupted provisioning when the Store survived", async () => {
    const { service, states, ark } = setup();
    const store = await ark.createMemoryStore({ name: "mawoker-a" });
    await ark.createMemory(store.id, {
      path: "/memories/.navigation.md",
      content: "stale",
    });
    states.set("a", {
      userId: "a",
      revision: 0,
      status: "repairing",
      storeId: store.id,
      policyEpoch: 0,
      protectedPaths: [],
      revokedPaths: [],
      autoDream: true,
      run: null,
      lastMonitorAt: 0,
      lastCompactAt: 0,
    });
    const result = await service.list("a");
    expect(result.state.status).toBe("active");
    expect(result.state.storeId).toBe(store.id);
    expect(
      result.entries.find((e) => e.path === "/memories/.navigation.md")
        ?.content,
    ).toBe("stale");
    expect(result.entries.map((e) => e.path)).toContain("/memories/profile.md");
  });
  it("recreates the Store when provisioning crashed before the id was saved", async () => {
    const { service, states } = setup();
    states.set("a", {
      userId: "a",
      revision: 0,
      status: "provisioning",
      storeId: null,
      policyEpoch: 0,
      protectedPaths: [],
      revokedPaths: [],
      autoDream: true,
      run: null,
      lastMonitorAt: 0,
      lastCompactAt: 0,
    });
    const result = await service.list("a");
    expect(result.state.status).toBe("active");
    expect(result.state.storeId).toBeTruthy();
    expect(result.entries.map((e) => e.path)).toEqual([
      "/episodes/handoff.md",
      "/memories/.index.md",
      "/memories/preferences.md",
      "/memories/profile.md",
      "/procedures/conventions.md",
      "/resources/README.md",
    ]);
  });
  it("keeps a quarantined run locked until recover observes the outcome", async () => {
    const { service, states, ark } = setup();
    const store = await service.ensure("a");
    await service.write("a", {
      path: "/memories/profile.md",
      content: "crashed write",
    });
    const quarantined = await service.status("a");
    quarantined.run!.steps[0].status = "sending";
    quarantined.run!.stage = "repairing";
    quarantined.run!.error = "crashed mid-send";
    quarantined.status = "repairing";
    states.set("a", quarantined);
    // The quarantined run keeps writes locked, but the Store stays readable.
    await expect(
      service.write("a", { path: "/memories/profile.md", content: "again" }),
    ).rejects.toMatchObject({ code: "MEMORY_BUSY" });
    const reading = await service.list("a");
    expect(reading.state.status).toBe("repairing");
    await expect(service.recover("a")).rejects.toMatchObject({
      code: "MEMORY_REPAIR_REQUIRED",
    });
    await ark.updateMemory(
      store,
      (await ark.listMemories(store)).find(
        (e) => e.path === "/memories/profile.md",
      )!.id,
      { path: "/memories/profile.md", content: "crashed write" },
    );
    await service.recover("a");
    const recovered = await service.status("a");
    expect(recovered.status).toBe("applying");
    expect(recovered.run?.stage).toBe("apply");
    expect(recovered.run?.steps[0]?.status).toBe("verified");
    await finish(service, "a");
    expect((await service.status("a")).run?.stage).toBe("completed");
    expect((await service.list("a")).state.status).toBe("active");
  });
  it("treats trailing thread status events as an ended turn", async () => {
    const harness = setup();
    await reachPolling(harness, { trailingThreadEvent: true });
    const { service, ark } = harness;
    const state = await service.status("a");
    const candidate = await ark.createMemoryStore({ name: "candidate" });
    ark.setDreamResult(state.run!.dreamId!, candidate.id);
    const finished = await finish(service, "a");
    expect(finished.run?.stage).toBe("completed");
    expect(finished.summarizedSources).toHaveLength(1);
  });
  it("fails a dream whose upstream wait exceeds the timeout", async () => {
    const harness = setup();
    await reachPolling(harness);
    const { service, ark } = harness;
    await service.advance("a"); // First pending observation anchors the wait.
    harness.setNow(1_000_000 + 1_800_001);
    await service.advance("a");
    // The failure routes through cleanup to drop the snapshot first.
    expect((await service.status("a")).run?.stage).toBe("cleanup");
    await service.advance("a");
    const state = await service.status("a");
    expect(state.run?.stage).toBe("failed");
    expect(state.status).toBe("active");
    expect(state.run?.snapshotId).toBeNull();
    expect(ark.calls.some((c) => c.operation === "deleteMemoryStore")).toBe(
      true,
    );
  });
  it("cancels a waiting dream and releases intermediate stores", async () => {
    const harness = setup();
    await reachPolling(harness);
    const { service, ark } = harness;
    const state = await service.cancel("a");
    expect(state.run?.stage).toBe("failed");
    expect(state.status).toBe("active");
    expect(state.run?.snapshotId).toBeNull();
    expect(ark.calls.some((c) => c.operation === "cancelDream")).toBe(true);
    expect(ark.calls.some((c) => c.operation === "deleteMemoryStore")).toBe(
      true,
    );
    await service.dream("a");
    expect((await service.status("a")).run?.stage).toBe("queued");
  });
  it("serves reads while a maintenance run is in flight", async () => {
    const harness = setup();
    await reachPolling(harness);
    const { service, ark } = harness;
    const state = await service.status("a");
    const candidate = await ark.createMemoryStore({ name: "candidate" });
    ark.setDreamResult(state.run!.dreamId!, candidate.id);
    await service.advance("a"); // Dream observed; the run is waiting at merge.
    expect((await service.status("a")).run?.stage).toBe("merge");
    // Viewing during consolidation returns the pre-update Store content
    // instead of a busy error; only writes stay gated on the run.
    const reading = await service.list("a");
    expect(reading.state.run?.stage).toBe("merge");
    expect(reading.entries.length).toBeGreaterThan(0);
    expect(reading.sessionCount).toBe(1);
  });
  it("fails a dream whose merge wait for quiescent sources exceeds the timeout", async () => {
    const harness = setup();
    await reachPolling(harness);
    const { service, ark, sessions } = harness;
    const state = await service.status("a");
    const candidate = await ark.createMemoryStore({ name: "candidate" });
    ark.setDreamResult(state.run!.dreamId!, candidate.id);
    await service.advance("a"); // Dream complete; the run is now waiting at merge.
    expect((await service.status("a")).run?.stage).toBe("merge");
    sessions[0]!.pending = true; // A source that never goes quiet.
    await service.advance("a"); // Anchors the merge wait.
    harness.setNow(1_000_000 + 1_800_001);
    await service.advance("a");
    // Same route as the poll timeout: cleanup releases the intermediate
    // Stores first, then the run fails and the Store returns to active.
    expect((await service.status("a")).run?.stage).toBe("cleanup");
    await service.advance("a");
    const after = await service.status("a");
    expect(after.run?.stage).toBe("failed");
    expect(after.status).toBe("active");
    expect(after.run?.candidateId).toBeNull();
    expect(ark.calls.some((c) => c.operation === "deleteMemoryStore")).toBe(
      true,
    );
  });
  it("migrates legacy session handoffs into the episodes skeleton", async () => {
    const { service, ark, states } = setup();
    const store = await ark.createMemoryStore({ name: "mawoker-a" });
    await ark.createMemory(store.id, {
      path: "/.abstract.md",
      content: "旧导航",
    });
    await ark.createMemory(store.id, {
      path: "/memories/profile.md",
      content: "knows TypeScript",
    });
    await ark.createMemory(store.id, {
      path: "/sessions/README.md",
      content: "进行中：记忆结构固化",
    });
    await ark.createMemory(store.id, {
      path: "/sessions/2026-10-11.md",
      content: "fact",
    });
    states.set("a", {
      userId: "a",
      revision: 0,
      status: "active",
      storeId: store.id,
      policyEpoch: 0,
      protectedPaths: [],
      revokedPaths: [],
      autoDream: false,
      run: null,
      lastMonitorAt: 0,
      lastCompactAt: 0,
    });
    await service.ensure("a");
    // Missing anchors are written immediately; moves complete through the run.
    const staged = (await ark.listMemories(store.id)).map((e) => e.path);
    expect(staged).toContain("/memories/preferences.md");
    expect(staged).toContain("/procedures/conventions.md");
    expect(staged).toContain("/episodes/handoff.md");
    expect((await service.status("a")).run?.stage).toBe("queued");
    await finish(service, "a");
    const entries = await ark.listMemories(store.id);
    const paths = entries.map((e) => e.path);
    expect(paths).not.toContain("/.abstract.md");
    expect(paths).not.toContain("/sessions/README.md");
    expect(paths).not.toContain("/sessions/2026-10-11.md");
    expect(paths).toContain("/episodes/digest/2026-10-11.md");
    expect(
      entries.find((e) => e.path === "/episodes/handoff.md")?.content,
    ).toContain("进行中：记忆结构固化");
    expect(
      entries.find((e) => e.path === "/memories/profile.md")?.content,
    ).toBe("knows TypeScript");
    expect((await service.status("a")).structureVersion).toBe(2);
  });
  it("marks an already-conforming store as current without scheduling a run", async () => {
    const { service, states } = setup();
    await service.ensure("a");
    const state = states.get("a")!;
    delete state.structureVersion;
    states.set("a", state);
    await service.ensure("a");
    const after = await service.status("a");
    expect(after.structureVersion).toBe(2);
    expect(after.run).toBeNull();
  });
  it("migrates a store carrying an inert terminal run from a failed dream", async () => {
    const { service, ark, states } = setup();
    const store = await ark.createMemoryStore({ name: "mawoker-a" });
    await ark.createMemory(store.id, {
      path: "/memories/profile.md",
      content: "knows TypeScript",
    });
    states.set("a", {
      userId: "a",
      revision: 0,
      status: "active",
      storeId: store.id,
      policyEpoch: 3,
      protectedPaths: [],
      revokedPaths: [],
      autoDream: false,
      run: {
        kind: "dream",
        stage: "failed",
        epoch: 3,
        baseline: [],
        snapshotId: null,
        candidateId: null,
        dreamId: "dream-stale",
        sources: [],
        steps: [],
        error: "来源会话已有新内容，需重新整理",
        before: null,
        after: null,
        pendingOperation: null,
        awaitedAt: null,
      },
      lastMonitorAt: 0,
      lastCompactAt: 0,
    });
    await service.ensure("a");
    const after = await service.status("a");
    expect(after.structureVersion).toBe(2);
    expect(after.run).toBeNull();
    const paths = (await ark.listMemories(store.id)).map((e) => e.path);
    expect(paths).toContain("/procedures/conventions.md");
    expect(paths).toContain("/episodes/handoff.md");
    expect(paths).toContain("/resources/README.md");
  });
  it("expedites the monitor and captures explicit remember-me sentences first", async () => {
    const { service, ark, sessions, states } = setup();
    const store = await service.ensure("a");
    const agent = await ark.createAgent({
      name: "A",
      description: "",
      modelId: "model-a",
      systemPrompt: "",
    });
    const session = await ark.createSession({
      agentId: agent.id,
      agentVersion: 1,
      environmentId: "env",
      resources: [
        { type: "memory_store", memoryStoreId: store, access: "read_write" },
      ],
    });
    ark.emitEvent(session.id, {
      type: "user.message",
      data: { content: "记住我喜欢简洁的回复。今天天气不错。" },
    });
    ark.emitEvent(session.id, {
      type: "agent.message",
      data: { content: "好的。" },
    });
    ark.emitEvent(session.id, {
      type: "session.status_idle",
      data: { stop_reason: { type: "end_turn" } },
    });
    sessions.push({
      id: "local",
      arkSessionId: session.id,
      memoryStoreId: store,
      pending: false,
      userId: "a",
    });
    // Outside the monitor window nothing runs.
    states.get("a")!.lastMonitorAt = 1_000_000;
    await service.runOnce();
    expect((await service.status("a")).run).toBeNull();
    // The turn-end trigger re-arms the monitor for the very next tick.
    await service.expedite("a");
    await service.runOnce();
    const planned = await service.status("a");
    expect(planned.run?.kind).toBe("edit");
    expect(planned.lastMonitorAt).toBe(0);
    await finish(service, "a");
    const digest = (await ark.listMemories(store)).find(
      (e) => e.path === `/episodes/digest/${session.id}.md`,
    );
    expect(digest?.content).toContain("sourceSessionId:");
    expect(digest?.content).toContain("记住我喜欢简洁的回复。");
    expect(digest?.content).not.toContain("今天天气不错。");
    // The re-armed monitor follows up with the semantic dream.
    await service.runOnce();
    expect((await service.status("a")).run?.kind).toBe("dream");
  });
  it("excludes an unconsolidated source on deletion without capturing it", async () => {
    const { service, ark, sessions, states } = setup();
    const store = await service.ensure("a");
    const agent = await ark.createAgent({
      name: "A",
      description: "",
      modelId: "model-a",
      systemPrompt: "",
    });
    const session = await ark.createSession({
      agentId: agent.id,
      agentVersion: 1,
      environmentId: "env",
      resources: [
        { type: "memory_store", memoryStoreId: store, access: "read_write" },
      ],
    });
    ark.emitEvent(session.id, {
      type: "user.message",
      data: { content: "预算 8000，评审周五。" },
    });
    ark.emitEvent(session.id, {
      type: "session.status_idle",
      data: { stop_reason: { type: "end_turn" } },
    });
    sessions.push({
      id: "local",
      arkSessionId: session.id,
      memoryStoreId: store,
      pending: false,
      userId: "a",
    });

    // Deleting an unconsolidated session must NOT create a long-term copy:
    // the fence registers a source exclusion and clears immediately.
    expect(await service.fenceDeletion("a", session.id)).toBe("clear");
    const entries = await ark.listMemories(store);
    expect(
      entries.filter((e) => e.path.startsWith("/episodes/digest/")),
    ).toEqual([]);
    expect(states.get("a")!.excludedSourceIds).toContain(session.id);
    // The exclusion is idempotent: a retried deletion clears again.
    expect(await service.fenceDeletion("a", session.id)).toBe("clear");
    // No capture run was planned.
    expect((await service.status("a")).run).toBeNull();
  });

  it("binds the exclusion tombstone to the deletion request identity", async () => {
    const { service, ark, sessions, states } = setup();
    const store = await service.ensure("a");
    const agent = await ark.createAgent({
      name: "A",
      description: "",
      modelId: "model-a",
      systemPrompt: "",
    });
    const session = await ark.createSession({
      agentId: agent.id,
      agentVersion: 1,
      environmentId: "env",
      resources: [
        { type: "memory_store", memoryStoreId: store, access: "read_write" },
      ],
    });
    sessions.push({
      id: "local",
      arkSessionId: session.id,
      memoryStoreId: store,
      pending: false,
      userId: "a",
    });

    await service.fenceDeletion("a", session.id, "delete-request-42");

    const state = states.get("a")!;
    expect(state.excludedSourceIds).toContain(session.id);
    // The tombstone names WHO asked for the deletion, so a later audit or
    // recovery replay can attribute the exclusion — identity only, no text.
    expect(state.sourceExclusions).toEqual([
      expect.objectContaining({
        arkSessionId: session.id,
        deletionRequestId: "delete-request-42",
      }),
    ]);
    // Without a request id the binding is simply absent (other callers).
    const other = await ark.createSession({
      agentId: agent.id,
      agentVersion: 1,
      environmentId: "env",
      resources: [
        { type: "memory_store", memoryStoreId: store, access: "read_write" },
      ],
    });
    sessions.push({
      id: "local-2",
      arkSessionId: other.id,
      memoryStoreId: store,
      pending: false,
      userId: "a",
    });
    await service.fenceDeletion("a", other.id);
    expect(states.get("a")!.sourceExclusions).toHaveLength(2);
    expect(
      states
        .get("a")!
        .sourceExclusions!.find((entry) => entry.arkSessionId === other.id)!
        .deletionRequestId,
    ).toBeUndefined();
  });

  it("waits for an in-flight run, then excludes the source and keeps its output", async () => {
    const { service, ark, sessions, states } = setup();
    const store = await service.ensure("a");
    const agent = await ark.createAgent({
      name: "A",
      description: "",
      modelId: "model-a",
      systemPrompt: "",
    });
    const session = await ark.createSession({
      agentId: agent.id,
      agentVersion: 1,
      environmentId: "env",
      resources: [
        { type: "memory_store", memoryStoreId: store, access: "read_write" },
      ],
    });
    ark.emitEvent(session.id, {
      type: "user.message",
      data: { content: "记住预算 8000。" },
    });
    ark.emitEvent(session.id, {
      type: "session.status_idle",
      data: { stop_reason: { type: "end_turn" } },
    });
    sessions.push({
      id: "local",
      arkSessionId: session.id,
      memoryStoreId: store,
      pending: false,
      userId: "a",
    });

    // A consolidation run that already started finishes safely: the fence
    // holds the deletion until the run is done, without planning a capture.
    states.get("a")!.lastMonitorAt = 0;
    await service.runOnce();
    expect((await service.status("a")).run?.kind).toBe("edit");
    expect(await service.fenceDeletion("a", session.id)).toBe("capturing");
    await finish(service, "a");
    const digest = (await ark.listMemories(store)).find(
      (e) => e.path === `/episodes/digest/${session.id}.md`,
    );
    // Content formed before the deletion request is kept...
    expect(digest?.content).toContain("记住预算 8000。");

    // ...and the source is then excluded so nothing new can be formed.
    expect(await service.fenceDeletion("a", session.id)).toBe("clear");
    expect(states.get("a")!.excludedSourceIds).toContain(session.id);
    expect(await service.fenceDeletion("a", session.id)).toBe("clear");
  });
});

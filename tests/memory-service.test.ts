import { describe, expect, it } from "vitest";
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
  const service = new MemoryService({
    repository,
    ark,
    modelId: "model-a",
    now: () => 1_000_000,
  });
  return { service, repository, states, ark, sessions };
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

describe("personal memory coordinator", () => {
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
      path: "/memories/events/a.md",
      content: "same",
    });
    await ark.createMemory(store, {
      path: "/memories/events/b.md",
      content: "same",
    });
    await service.protect("a", "/memories/events/b.md", true);
    await service.compress("a");
    await finish(service, "a");
    const paths = (await service.list("a")).entries.map((e) => e.path);
    expect(paths).toContain("/memories/events/b.md");
    expect(paths).not.toContain("/memories/events/a.md");
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
        path: `/memories/events/topic/${i}.md`,
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
});

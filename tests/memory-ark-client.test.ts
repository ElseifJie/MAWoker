import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  HttpArkGateway,
  InMemoryArkGateway,
  type ArkGateway,
  type ArkResource,
  type ArkResourceInput,
} from "../packages/ark-client/src/index.js";

const agentInput = {
  name: "Personal",
  description: "",
  modelId: "model-1",
  systemPrompt: "Remember preferences.",
};
const memoryInput = { path: "/profile.md", content: "hello" };
const dreamInput = {
  memoryStoreId: "store-1",
  sessionIds: ["session-1"],
  modelId: "model-1",
  instructions: "Keep verified facts.",
};
const storeWire = {
  id: "store-1",
  name: "Personal",
  memory_count: 1,
  storage_bytes: 5,
  type: "memory_store",
};
const memoryWire = {
  id: "mem-1",
  path: memoryInput.path,
  content_sha256: createHash("sha256").update("hello").digest("hex"),
  memory_version_id: "version-1",
  content_size_bytes: 5,
  type: "memory",
};
const dreamWire = {
  id: "dream-1",
  status: "pending",
  outputs: [{ type: "memory_store", memory_store_id: "output-1" }],
  usage: null,
};

function http(responses: unknown[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) {
    fetch.mockResolvedValueOnce(Response.json(response));
  }
  return {
    fetch,
    gateway: new HttpArkGateway({
      baseUrl: "https://ark.example",
      apiKey: "test",
      fetch,
      sleep: async () => {},
    }),
  };
}

describe("Memory Store stub", () => {
  it("creates, reads and deletes stores with complete memory inventory and capacity", async () => {
    const gateway: ArkGateway = new InMemoryArkGateway();
    const store = await gateway.createMemoryStore({
      name: "Personal",
      description: "Private",
    });
    expect(store).toMatchObject({
      name: "Personal",
      memoryCount: 0,
      storageBytes: 0,
    });
    const memory = await gateway.createMemory(store.id, memoryInput);
    expect(memory).toMatchObject({
      ...memoryInput,
      sizeBytes: 5,
      contentSha256: memoryWire.content_sha256,
    });
    expect(memory.memoryVersionId).toBeTruthy();
    expect(await gateway.getMemory(store.id, memory.id)).toEqual(memory);
    expect(await gateway.listMemories(store.id)).toEqual([memory]);
    expect(await gateway.getMemoryStore(store.id)).toMatchObject({
      memoryCount: 1,
      storageBytes: 5,
    });
    await gateway.deleteMemory(store.id, memory.id);
    expect(await gateway.listMemories(store.id)).toEqual([]);
    await expect(gateway.getMemory(store.id, memory.id)).rejects.toMatchObject({
      category: "not_found",
    });
    await gateway.createMemory(store.id, memoryInput);
    await gateway.deleteMemoryStore(store.id);
    await expect(gateway.getMemoryStore(store.id)).rejects.toMatchObject({
      category: "not_found",
    });
    await expect(gateway.listMemories(store.id)).rejects.toMatchObject({
      category: "not_found",
    });
  });

  it("updates hashes and versions, moves to a new ID, and rejects duplicate paths atomically", async () => {
    const gateway = new InMemoryArkGateway();
    const store = await gateway.createMemoryStore({ name: "Personal" });
    const original = await gateway.createMemory(store.id, memoryInput);
    const updated = await gateway.updateMemory(store.id, original.id, {
      ...memoryInput,
      content: "new",
    });
    expect(updated.id).toBe(original.id);
    expect(updated.memoryVersionId).not.toBe(original.memoryVersionId);
    expect(updated.contentSha256).toBe(
      createHash("sha256").update("new").digest("hex"),
    );
    const moved = await gateway.updateMemory(store.id, original.id, {
      path: "/moved.md",
      content: "new",
    });
    expect(moved.id).not.toBe(original.id);
    await expect(
      gateway.getMemory(store.id, original.id),
    ).rejects.toMatchObject({ category: "not_found" });
    await expect(
      gateway.createMemory(store.id, {
        path: moved.path,
        content: "duplicate",
      }),
    ).rejects.toMatchObject({ category: "invalid_response" });
    const other = await gateway.createMemory(store.id, memoryInput);
    await expect(
      gateway.updateMemory(store.id, other.id, {
        path: moved.path,
        content: "collision",
      }),
    ).rejects.toMatchObject({ category: "invalid_response" });
    expect(await gateway.getMemory(store.id, other.id)).toEqual(other);
    expect(await gateway.getMemoryStore(store.id)).toMatchObject({
      memoryCount: 2,
      storageBytes: 8,
    });
  });

  it("enforces 2000 entries and 102400 UTF-8 bytes but permits updates at capacity", async () => {
    const gateway = new InMemoryArkGateway();
    const store = await gateway.createMemoryStore({ name: "Personal" });
    const first = await gateway.createMemory(store.id, {
      path: "/0.md",
      content: "a".repeat(102400),
    });
    for (let i = 1; i < 2000; i += 1) {
      await gateway.createMemory(store.id, { path: `/${i}.md`, content: "" });
    }
    await expect(
      gateway.createMemory(store.id, memoryInput),
    ).rejects.toMatchObject({ category: "invalid_response" });
    await expect(
      gateway.updateMemory(store.id, first.id, {
        path: "/0.md",
        content: "\u00e9".repeat(51201),
      }),
    ).rejects.toMatchObject({ category: "invalid_response" });
    expect(
      await gateway.updateMemory(store.id, first.id, {
        path: "/renamed.md",
        content: "",
      }),
    ).toMatchObject({ sizeBytes: 0 });
    expect(await gateway.getMemoryStore(store.id)).toMatchObject({
      memoryCount: 2000,
      storageBytes: 0,
    });
  });

  it.each([
    "relative.md",
    "/a/../b.md",
    "/a//b.md",
    "/a?.md",
    "/a.json",
    "/a\u0000.md",
  ])("rejects invalid memory path %s", async (path) => {
    const gateway = new InMemoryArkGateway();
    const store = await gateway.createMemoryStore({ name: "Personal" });
    await expect(
      gateway.createMemory(store.id, { path, content: "" }),
    ).rejects.toMatchObject({ category: "invalid_response" });
  });

  it("mounts files and shared stores without changing file resource consumer typing", async () => {
    const gateway = new InMemoryArkGateway();
    const store = await gateway.createMemoryStore({ name: "Personal" });
    const agent = await gateway.createAgent(agentInput);
    const file = await gateway.uploadFile({
      name: "input.txt",
      contentType: "text/plain",
      bytes: new Uint8Array(),
      purpose: "agent",
    });
    const resources: ArkResourceInput[] = [
      { fileId: file.id, mountPath: "/input.txt" },
      { type: "memory_store", memoryStoreId: store.id, access: "read_write" },
    ];
    for (let i = 0; i < 2; i += 1) {
      const session = await gateway.createSession({
        agentId: agent.id,
        agentVersion: agent.version,
        environmentId: "env-1",
        resources,
      });
      const files: ArkResource[] = await gateway.listSessionResources(
        session.id,
      );
      expect(files.map((resource) => resource.fileId)).toEqual([file.id]);
    }
    await expect(
      gateway.createSession({
        agentId: agent.id,
        agentVersion: agent.version,
        environmentId: "env-1",
        resources: [
          {
            type: "memory_store",
            memoryStoreId: "missing",
            access: "read_only",
          },
        ],
      }),
    ).rejects.toMatchObject({ category: "not_found" });
  });

  it("controls Dream output independently, blocks unfinished output and cancels tasks", async () => {
    const gateway = new InMemoryArkGateway();
    const store = await gateway.createMemoryStore({ name: "Personal" });
    const agent = await gateway.createAgent(agentInput);
    const session = await gateway.createSession({
      agentId: agent.id,
      agentVersion: agent.version,
      environmentId: "env-1",
      resources: [],
    });
    const input = {
      ...dreamInput,
      memoryStoreId: store.id,
      sessionIds: [session.id],
    };
    const dream = await gateway.createDream(input);
    expect(dream).toMatchObject({ status: "pending", usage: null });
    expect(dream.outputMemoryStoreId).not.toBe(store.id);
    await expect(
      gateway.listMemories(dream.outputMemoryStoreId!),
    ).rejects.toMatchObject({ category: "runtime_busy" });
    const output = await gateway.createMemoryStore({ name: "Candidate" });
    gateway.setDreamResult(dream.id, output.id);
    expect(await gateway.getDream(dream.id)).toMatchObject({
      status: "completed",
      outputMemoryStoreId: output.id,
    });
    const canceled = await gateway.createDream(input);
    expect(await gateway.cancelDream(canceled.id)).toMatchObject({
      status: "canceled",
    });
    expect(await gateway.getDream(canceled.id)).toMatchObject({
      status: "canceled",
    });
    await expect(gateway.cancelDream(dream.id)).rejects.toMatchObject({
      category: "invalid_response",
    });
    const failed = await gateway.createDream(input);
    gateway.setDreamResult(failed.id, output.id, "failed");
    expect(await gateway.getDream(failed.id)).toMatchObject({
      status: "failed",
    });
    await expect(
      gateway.createDream({ ...input, sessionIds: [] }),
    ).rejects.toMatchObject({ category: "invalid_response" });
    await expect(
      gateway.createDream({ ...input, sessionIds: [session.id, session.id] }),
    ).rejects.toMatchObject({ category: "invalid_response" });
  });

  it("injects failures for reads and writes without replaying a mutation", async () => {
    const gateway = new InMemoryArkGateway();
    const store = await gateway.createMemoryStore({ name: "Personal" });
    gateway.failNext("createMemory", "connection_failure");
    await expect(
      gateway.createMemory(store.id, memoryInput),
    ).rejects.toMatchObject({ category: "unknown_write_outcome" });
    gateway.failNext("listMemories", "connection_failure");
    await expect(gateway.listMemories(store.id)).rejects.toMatchObject({
      category: "unavailable",
    });
    expect(await gateway.listMemories(store.id)).toEqual([]);
  });
});

describe("Memory Store HTTP shapes", () => {
  it("parses mixed official resource inventory while returning file-only resources", async () => {
    const { gateway } = http([
      [
        {
          id: "resource-1",
          type: "file",
          file_id: "file-1",
          mount_path: "/input.txt",
        },
        {
          id: "resource-2",
          type: "memory_store",
          memory_store_id: "store-1",
          access: "read_only",
        },
      ],
    ]);
    expect(await gateway.listSessionResources("session-1")).toEqual([
      { id: "resource-1", fileId: "file-1", mountPath: "/input.txt" },
    ]);
  });

  it("retries safe reads and normalizes an absent Dream output or usage to null", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError("temporary"))
      .mockResolvedValueOnce(
        Response.json({ id: "dream-1", status: "failed" }),
      );
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example",
      apiKey: "test",
      fetch,
      sleep: async () => {},
    });
    expect(await gateway.getDream("dream-1")).toEqual({
      id: "dream-1",
      status: "failed",
      outputMemoryStoreId: null,
      usage: null,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("normalizes Store CRUD and POST Memory writes, echoing the written content", async () => {
    const { gateway, fetch } = http([
      storeWire,
      storeWire,
      memoryWire,
      { ...memoryWire, content: "hello" },
      { ...memoryWire, id: "mem-2", path: "/moved.md" },
      { deleted: true },
      { deleted: true },
    ]);
    expect(
      await gateway.createMemoryStore({
        name: "Personal",
        description: "Private",
      }),
    ).toEqual({
      id: "store-1",
      name: "Personal",
      memoryCount: 1,
      storageBytes: 5,
    });
    expect(await gateway.getMemoryStore("store-1")).toMatchObject({
      memoryCount: 1,
    });
    expect(await gateway.createMemory("store-1", memoryInput)).toMatchObject({
      ...memoryInput,
      sizeBytes: 5,
      memoryVersionId: "version-1",
    });
    expect(await gateway.getMemory("store-1", "mem-1")).toMatchObject(
      memoryInput,
    );
    expect(
      await gateway.updateMemory("store-1", "mem-1", {
        ...memoryInput,
        path: "/moved.md",
      }),
    ).toMatchObject({ id: "mem-2", content: "hello" });
    await gateway.deleteMemory("store-1", "mem-2");
    await gateway.deleteMemoryStore("store-1");
    expect(
      fetch.mock.calls.map(([url, init]) => [
        String(url).replace("https://ark.example", ""),
        init?.method,
      ]),
    ).toEqual([
      ["/api/v3/memory_stores", "POST"],
      ["/api/v3/memory_stores/store-1", "GET"],
      ["/api/v3/memory_stores/store-1/memories", "POST"],
      ["/api/v3/memory_stores/store-1/memories/mem-1", "GET"],
      ["/api/v3/memory_stores/store-1/memories/mem-1", "POST"],
      ["/api/v3/memory_stores/store-1/memories/mem-2", "DELETE"],
      ["/api/v3/memory_stores/store-1", "DELETE"],
    ]);
    expect(JSON.parse(fetch.mock.calls[4]![1]!.body as string)).toEqual({
      path: "/moved.md",
      content: "hello",
    });
    expect(fetch.mock.calls[4]![1]!.headers).not.toHaveProperty("if-match");
  });

  it("paginates metadata first then gets every full entry, including data-only final pages", async () => {
    const second = { ...memoryWire, id: "mem-2", path: "/second.md" };
    const { gateway, fetch } = http([
      { data: [memoryWire], next_page: "opaque+/=" },
      { data: [second] },
      { ...memoryWire, content: "hello" },
      { ...second, content: "hello" },
    ]);
    expect(await gateway.listMemories("store/1")).toEqual([
      {
        id: "mem-1",
        ...memoryInput,
        contentSha256: memoryWire.content_sha256,
        memoryVersionId: "version-1",
        sizeBytes: 5,
      },
      {
        id: "mem-2",
        ...memoryInput,
        path: "/second.md",
        contentSha256: memoryWire.content_sha256,
        memoryVersionId: "version-1",
        sizeBytes: 5,
      },
    ]);
    const urls = fetch.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls[0]!.pathname).toBe("/api/v3/memory_stores/store%2F1/memories");
    expect(urls[1]!.searchParams.get("page")).toBe("opaque+/=");
    expect(urls[0]!.searchParams.get("limit")).toBe(
      urls[1]!.searchParams.get("limit"),
    );
    expect(urls[0]!.searchParams.has("depth")).toBe(false);
  });

  it("rejects cursor loops and does not return partial inventory when a detail read fails", async () => {
    const loop = http([
      { data: [], next_page: "repeat" },
      { data: [], next_page: "repeat" },
    ]);
    await expect(loop.gateway.listMemories("store-1")).rejects.toMatchObject({
      category: "invalid_response",
    });
    const detail = http([{ data: [memoryWire] }, { ...memoryWire }]);
    await expect(detail.gateway.listMemories("store-1")).rejects.toMatchObject({
      category: "invalid_response",
    });
  });

  it("uses official Dream inputs, required output name, output array and nonterminal cancel response", async () => {
    const { gateway, fetch } = http([
      dreamWire,
      { ...dreamWire, status: "completed", usage: { input_tokens: 10 } },
      { ...dreamWire, status: "running" },
    ]);
    expect(await gateway.createDream(dreamInput)).toEqual({
      id: "dream-1",
      status: "pending",
      outputMemoryStoreId: "output-1",
      usage: null,
    });
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({
      inputs: [
        { type: "memory_store", memory_store_id: "store-1" },
        { type: "sessions", session_ids: ["session-1"] },
      ],
      model: "model-1",
      instructions: dreamInput.instructions,
      output_memory_store_name: "dream-curated-memory",
    });
    expect(await gateway.getDream("dream-1")).toMatchObject({
      status: "completed",
      usage: { input_tokens: 10 },
    });
    expect(await gateway.cancelDream("dream/1")).toMatchObject({
      status: "running",
    });
    expect(fetch.mock.calls[2]![0]).toBe(
      "https://ark.example/api/v3/dreams/dream%2F1/cancel",
    );
  });

  it.each([
    [
      "createMemoryStore",
      (g: HttpArkGateway) => g.createMemoryStore({ name: "Personal" }),
    ],
    [
      "deleteMemoryStore",
      (g: HttpArkGateway) => g.deleteMemoryStore("store-1"),
    ],
    [
      "createMemory",
      (g: HttpArkGateway) => g.createMemory("store-1", memoryInput),
    ],
    [
      "updateMemory",
      (g: HttpArkGateway) => g.updateMemory("store-1", "mem-1", memoryInput),
    ],
    ["deleteMemory", (g: HttpArkGateway) => g.deleteMemory("store-1", "mem-1")],
    ["createDream", (g: HttpArkGateway) => g.createDream(dreamInput)],
    ["cancelDream", (g: HttpArkGateway) => g.cancelDream("dream-1")],
  ] as const)("does not safely retry mutation %s", async (_name, invoke) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new TypeError("connection lost"));
    const gateway = new HttpArkGateway({
      baseUrl: "https://ark.example",
      apiKey: "test",
      fetch,
    });
    await expect(invoke(gateway)).rejects.toMatchObject({
      category: "unknown_write_outcome",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["initializing", "upgrading", "failed", "rescheduling"])(
    "accepts official Session status %s and mixed resource serialization",
    async (status) => {
      const { gateway, fetch } = http([
        {
          id: "session-1",
          agent: { id: "agent-1", version: 1 },
          environment_id: "env-1",
          status,
        },
      ]);
      expect(
        await gateway.createSession({
          agentId: "agent-1",
          agentVersion: 1,
          environmentId: "env-1",
          resources: [
            { fileId: "file-1", mountPath: "/input.txt" },
            {
              type: "memory_store",
              memoryStoreId: "store-1",
              access: "read_write",
            },
          ],
        }),
      ).toMatchObject({
        status: status === "rescheduling" ? "rescheduled" : status,
      });
      expect(
        JSON.parse(fetch.mock.calls[0]![1]!.body as string).resources,
      ).toEqual([
        { type: "file", file_id: "file-1", mount_path: "/input.txt" },
        {
          type: "memory_store",
          memory_store_id: "store-1",
          access: "read_write",
        },
      ]);
    },
  );
});

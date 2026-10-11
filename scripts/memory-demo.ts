import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { InMemoryArkGateway } from "../packages/ark-client/src/stub.js";
import { createMemoryRepository } from "../packages/db/src/memory-repository.js";
import * as schema from "../packages/db/src/schema.js";
import { MemoryService } from "../packages/domain/src/memory.js";

const userA = "00000000-0000-4000-8000-000000000001";
const userB = "00000000-0000-4000-8000-000000000002";
const agentId = "00000000-0000-4000-8000-000000000003";
const modelId = "offline-demo-model";
const environmentId = "offline-demo-environment";
const preferencePath = "/memories/preferences/workflow.md";
const protectedPath = "/episodes/digest/project/0000.md";
const maxTicks = 3000;
const started = Date.now();
const progress = (message: string) =>
  console.error(
    `[memory-demo +${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`,
  );

// Each tick advances the real coordinator once; terminal failures never pass.
async function advanceUntil(
  service: MemoryService,
  userId: string,
  target = "completed",
) {
  const stages: string[] = [];
  for (let ticks = 0; ticks <= maxTicks; ticks++) {
    const state = await service.status(userId);
    const stage = state.run?.stage;
    assert(stage, "缺少已排队的任务");
    if (stages.at(-1) !== stage) {
      stages.push(stage);
      progress(`${state.run!.kind}: ${stage} (tick ${ticks})`);
    }
    assert(!["failed", "repairing"].includes(stage), state.run?.error ?? stage);
    if (stage === target) return { ticks, stages, state };
    assert(ticks < maxTicks, `超过 ${maxTicks} ticks，仍处于 ${stage}`);
    await service.advance(userId);
  }
  throw new Error("无法到达目标阶段");
}

async function main() {
  // No dataDir, application configuration, environment loader or cloud client.
  const client = new PGlite();
  try {
    progress("初始化临时 PGlite 并执行迁移");
    const db = drizzle(client, { schema });
    await migrate(db, {
      migrationsFolder: fileURLToPath(
        new URL("../packages/db/migrations/", import.meta.url),
      ),
    });
    await db.insert(schema.users).values([
      { id: userA, authSubject: "demo:a", email: "a@memory-demo.invalid" },
      { id: userB, authSubject: "demo:b", email: "b@memory-demo.invalid" },
    ]);
    const ark = new InMemoryArkGateway({
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    const repository = createMemoryRepository(db);
    const dependencies = {
      repository,
      ark,
      modelId,
      now: () => 100_000_000,
    };
    const service = new MemoryService(dependencies);
    const sharedAgent = await ark.createAgent({
      name: "共享工作助手",
      description: "同一 Agent，个人记忆按用户隔离",
      modelId,
      systemPrompt: "按需读取个人记忆，不保存凭证。",
    });
    assert.equal(typeof sharedAgent.systemPrompt, "string");
    assert(sharedAgent.systemPrompt);
    await db.insert(schema.platformAgents).values({
      id: agentId,
      arkAgentId: sharedAgent.id,
      name: sharedAgent.name,
      modelId,
      systemPrompt: sharedAgent.systemPrompt,
      arkVersion: String(sharedAgent.version),
      status: "active",
      createdBy: userA,
      updatedBy: userA,
    });

    async function newSession(userId: string, localId: string) {
      const storeId = await service.ensure(userId);
      await service.gate(userId);
      const session = await ark.createSession({
        agentId: sharedAgent.id,
        agentVersion: sharedAgent.version,
        environmentId,
        resources: [
          {
            type: "memory_store",
            memoryStoreId: storeId,
            access: "read_write",
          },
        ],
      });
      await db.insert(schema.sessions).values({
        id: localId,
        ownerUserId: userId,
        arkSessionId: session.id,
        agentKind: "platform",
        platformAgentId: agentId,
        arkAgentId: sharedAgent.id,
        agentName: sharedAgent.name,
        agentVersion: String(sharedAgent.version),
        environmentId,
        memoryStoreId: storeId,
        status: "idle",
      });
      return { sessionId: session.id, storeId };
    }

    const a1 = await newSession(userA, "00000000-0000-4000-8000-000000000011");
    const b1 = await newSession(userB, "00000000-0000-4000-8000-000000000012");
    await service.settings(userA, false);
    await service.settings(userB, false);
    assert.notEqual(a1.storeId, b1.storeId);
    const preference = "偏好中文答复；先列步骤，再给结论。";
    const queued = await service.write(userA, {
      path: preferencePath,
      content: preference,
    });
    assert.equal(queued.run?.stage, "queued");
    assert(
      !(await ark.listMemories(a1.storeId)).some(
        (e) => e.path === preferencePath,
      ),
    );
    const write = await advanceUntil(service, userA);
    assert.equal(
      (await service.list(userA)).entries.find((e) => e.path === preferencePath)
        ?.content,
      preference,
    );
    assert(
      !(await service.list(userB)).entries.some(
        (e) => e.path === preferencePath,
      ),
    );
    const a2 = await newSession(userA, "00000000-0000-4000-8000-000000000013");
    assert.equal(a2.storeId, a1.storeId);
    const reloaded = new MemoryService({
      ...dependencies,
      repository: createMemoryRepository(db),
    });
    assert.equal(await reloaded.ensure(userA), a1.storeId);
    const bindings = await db.select().from(schema.userMemoryStores);
    assert.equal(bindings.length, 2);
    for (const binding of bindings) {
      const state = await reloaded.status(binding.userId);
      assert.equal(binding.fixedStoreId, state.storeId);
      assert.equal(binding.revision, state.revision);
    }
    const sessionBindings = await repository.sessions(userA);
    assert.equal(sessionBindings.length, 2);
    assert(
      sessionBindings.every(
        (s) => s.memoryStoreId === a1.storeId && !s.pending,
      ),
    );
    const sessionCalls = ark.calls.filter(
      (c) => c.operation === "createSession",
    );
    assert(sessionCalls.every((c) => c.input.agentId === sharedAgent.id));
    assert.deepEqual(
      sessionCalls.map((c) => c.input.resources),
      [
        [
          {
            type: "memory_store",
            memoryStoreId: a1.storeId,
            access: "read_write",
          },
        ],
        [
          {
            type: "memory_store",
            memoryStoreId: b1.storeId,
            access: "read_write",
          },
        ],
        [
          {
            type: "memory_store",
            memoryStoreId: a1.storeId,
            access: "read_write",
          },
        ],
      ],
    );

    const protectedContent = "确认事实：项目预算 8000 元；不得自动改写。";
    await service.write(userA, {
      path: protectedPath,
      content: protectedContent,
    });
    await advanceUntil(service, userA);
    await service.protect(userA, protectedPath, true);
    const protectedEntry = (await ark.listMemories(a1.storeId)).find(
      (e) => e.path === protectedPath,
    )!;
    const evidence = "每周五下午复盘项目，保留预算和日期。";
    ark.emitEvent(a1.sessionId, {
      type: "user.message",
      data: { content: evidence },
    });
    ark.emitEvent(a1.sessionId, {
      type: "session.status_idle",
      data: { stop_reason: { type: "end_turn" } },
    });
    await service.dream(userA);
    const submitted = await advanceUntil(service, userA, "polling");
    assert.equal(submitted.state.status, "active");
    const snapshotId = submitted.state.run!.snapshotId!;
    assert.notEqual(snapshotId, a1.storeId);
    assert.deepEqual(
      await ark
        .listMemories(snapshotId)
        .then((entries) =>
          entries.map((e) => ({ path: e.path, content: e.content })),
        ),
      submitted.state.run!.baseline.map((e) => ({
        path: e.path,
        content: e.content,
      })),
    );
    await service.advance(userA);
    assert.equal((await service.status(userA)).run?.stage, "polling");
    // Simulate an upstream tool write while Dream works from its old snapshot.
    // The public service.write intentionally rejects edits during active runs.
    const correction = "用户纠正：只给中文短结论，不再先列步骤。";
    const oldPreference = (await ark.listMemories(a1.storeId)).find(
      (e) => e.path === preferencePath,
    )!;
    await ark.updateMemory(a1.storeId, oldPreference.id, {
      path: preferencePath,
      content: correction,
    });
    const dreamId = submitted.state.run!.dreamId!;
    const dream = await ark.getDream(dreamId);
    const candidateId = dream.outputMemoryStoreId!;
    assert.notEqual(candidateId, a1.storeId);
    assert.notEqual(candidateId, snapshotId);
    // Use the stub's own output Store, avoiding an unused extra candidate.
    ark.setDreamResult(dreamId, candidateId);
    const sourced = `sourceSessionId: ${a1.sessionId}\n${evidence}`;
    const newPath = "/memories/preferences/review.md";
    await ark.createMemory(candidateId, { path: newPath, content: sourced });
    await ark.createMemory(candidateId, {
      path: preferencePath,
      content: `${preference}\n${sourced}`,
    });
    await ark.createMemory(candidateId, {
      path: protectedPath,
      content: sourced,
    });
    const merged = await advanceUntil(service, userA);
    const afterDream = (await service.list(userA)).entries;
    assert.equal(
      afterDream.find((e) => e.path === preferencePath)?.content,
      correction,
    );
    assert.equal(afterDream.find((e) => e.path === newPath)?.content, sourced);
    assert.deepEqual(
      afterDream.find((e) => e.path === protectedPath),
      protectedEntry,
    );
    assert.equal(await reloaded.ensure(userA), a1.storeId);
    await assert.rejects(ark.getMemoryStore(snapshotId), {
      category: "not_found",
    });
    await assert.rejects(ark.getMemoryStore(candidateId), {
      category: "not_found",
    });
    const dreamCall = ark.calls.find((c) => c.operation === "createDream")!;
    assert.equal(dreamCall.input.memoryStoreId, snapshotId);
    assert.deepEqual(dreamCall.input.sessionIds, [a1.sessionId]);

    // Bulk fixture writes model upstream event memories, not UI queued edits.
    const sources: Array<{ path: string; content: string }> = [];
    const pathsById = new Map<string, string>();
    progress("写入 1600 条事件：20 条可打包，其余为独立子目录");
    for (let i = 1; i <= 1600; i++) {
      const entry = {
        path:
          i <= 20
            ? `/episodes/digest/project/${String(i).padStart(4, "0")}.md`
            : `/episodes/digest/independent-${i}/event.md`,
        content: `事件 ${i}：2026-01-01 项目验收；预算 ${8000 + i} 元；例外 ${i % 7}；来源 demo-event-${i}。`,
      };
      sources.push(entry);
      const created = await ark.createMemory(a1.storeId, entry);
      pathsById.set(created.id, entry.path);
      if (i % 400 === 0) progress(`事件已写入 ${i}/1600`);
    }
    const dreamCount = ark.calls.filter(
      (c) => c.operation === "createDream",
    ).length;
    const monitorCount = await service.runOnce();
    const autoQueued = await service.status(userA);
    assert.equal(autoQueued.run?.kind, "compress");
    assert.equal(autoQueued.run?.stage, "queued");
    // The monitor pass maintains the navigation index before queueing the
    // compression, so capture the capacity the run actually baselines against.
    const before = (await service.list(userA)).capacity;
    assert.equal(before.level, "high");
    const callStart = ark.calls.length;
    const compacted = await advanceUntil(service, userA);
    const after = await service.list(userA);
    assert.deepEqual(compacted.state.run?.before, before);
    assert.deepEqual(compacted.state.run?.after, after.capacity);
    assert(after.capacity.count < before.count);
    assert(after.capacity.count > after.capacity.targetCount);
    assert.deepEqual(
      after.entries.find((e) => e.path === protectedPath),
      protectedEntry,
    );
    assert(compacted.state.protectedPaths.includes(protectedPath));
    assert.equal(
      after.entries.find((e) => e.path === preferencePath)?.content,
      correction,
    );
    for (const source of sources) {
      const block = `\n## 来源路径 ${source.path}\n${source.content}\n`;
      assert(
        after.entries.some(
          (e) =>
            (e.path === source.path && e.content === source.content) ||
            e.content.includes(block),
        ),
        `来源原文丢失：${source.path}`,
      );
    }
    const mutations = ark.calls
      .slice(callStart)
      .filter((c) =>
        ["updateMemory", "createMemory", "deleteMemory"].includes(c.operation),
      );
    assert.equal(mutations[0]?.operation, "updateMemory");
    const covered = new Set<string>();
    const deletedIds = new Set<string>();
    for (const mutation of mutations) {
      assert.equal(mutation.input.memoryStoreId, a1.storeId);
      if (mutation.operation === "updateMemory") {
        const content = String(mutation.input.content);
        for (const { path } of sources) {
          if (content.includes(`\n## 来源路径 ${path}\n`)) covered.add(path);
        }
      } else {
        assert.equal(
          mutation.operation,
          "deleteMemory",
          "压缩不应新建存留条目",
        );
        const id = String(mutation.input.memoryId);
        const path = pathsById.get(id);
        assert(path && covered.has(path), "删除来源前必须先更新存留条目");
        deletedIds.add(id);
      }
    }
    assert(deletedIds.size > 0);
    assert.equal(
      dreamCount,
      ark.calls.filter((c) => c.operation === "createDream").length,
    );
    assert.equal(await reloaded.ensure(userA), a1.storeId);
    assert(
      !(await service.list(userB)).entries.some(
        (e) =>
          e.path === preferencePath ||
          e.path === newPath ||
          e.path.startsWith("/episodes/digest/"),
      ),
    );

    progress("全部断言通过，输出中文 JSON");
    console.log(
      JSON.stringify(
        {
          结果: "通过",
          模式: "真实 MemoryService + 已迁移临时 PGlite + InMemoryArkGateway（无云调用）",
          隔离: {
            共享Agent: sharedAgent.id,
            用户A: { 固定库: a1.storeId, 会话: [a1.sessionId, a2.sessionId] },
            用户B: { 固定库: b1.storeId, 会话: [b1.sessionId] },
            同一用户跨会话复用: true,
            不同用户不同库: true,
            数据库绑定一致: true,
          },
          偏好: {
            写入阶段: write.stages,
            ticks: write.ticks,
            原偏好: preference,
            最新纠正: correction,
          },
          Dream: {
            阶段: [...submitted.stages, ...merged.stages.slice(1)],
            ticks: submitted.ticks + 1 + merged.ticks,
            轮询等待已验证: true,
            来源会话: [a1.sessionId],
            纠正保留: true,
            新记忆: sourced,
            临时库已清理: true,
          },
          压缩: {
            自动排队: true,
            可打包事件: 20,
            部分压缩: after.capacity.count > after.capacity.targetCount,
            本次监控用户数: monitorCount,
            事件条目: sources.length,
            阶段: compacted.stages,
            ticks: compacted.ticks,
            之前: before,
            之后: after.capacity,
            更新次数: mutations.filter((c) => c.operation === "updateMemory")
              .length,
            删除次数: deletedIds.size,
            原文路径全部保留: true,
            保护条目保持原样: true,
            先更新存留条目再删除: true,
            未创建Dream: true,
            说明: "仅同目录20条事件打包；独立子目录保留，因此仍高于目标。来源标题增加字节。",
          },
        },
        null,
        2,
      ),
    );
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("记忆演示失败：", error);
  process.exitCode = 1;
});

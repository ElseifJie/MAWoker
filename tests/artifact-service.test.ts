import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import {
  ArtifactService,
  ResourceNotFoundError,
  type ArtifactRecord,
  type ArtifactRepository,
} from "../packages/domain/src/index.js";
import { InMemoryArtifactStorage } from "../packages/storage/src/index.js";

const userId = "00000000-0000-4000-8000-000000000001";
const otherUserId = "00000000-0000-4000-8000-000000000002";
const sessionId = "00000000-0000-4000-8000-000000000003";
const artifactId = "00000000-0000-4000-8000-000000000004";
const now = new Date("2026-09-06T00:00:00.000Z");

async function collect(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return new Uint8Array(Buffer.concat(chunks));
}

const exportBucket = "ark-exports";

/** The TOS location Ark reports for an export; mirrors `ArkArtifact.tos`. */
function exportLocation(arkFileId: string): {
  bucket: string;
  objectKey: string;
} {
  return { bucket: exportBucket, objectKey: `ark/outputs/env-1/${arkFileId}` };
}

function exportEntry(
  arkFileId: string,
  name: string,
  size: number,
  overrides: { sessionId?: string; contentType?: string } = {},
) {
  return {
    id: arkFileId,
    sessionId: overrides.sessionId ?? "ark-session-1",
    name,
    contentType: overrides.contentType ?? "text/plain",
    size,
    createdAt: now.toISOString(),
    tos: exportLocation(arkFileId),
  };
}

function setup() {
  let nextId = 0;
  const records = new Map<string, ArtifactRecord>();
  const cleanupJobs = new Map<
    string,
    {
      ownerUserId: string;
      objectKey: string;
      runAfter: Date;
      status: "pending" | "succeeded";
    }
  >();
  const stageCleanup = vi.fn(
    async (input: {
      id: string;
      ownerUserId: string;
      sessionId: string;
      objectKey: string;
      runAfter: Date;
    }) => {
      cleanupJobs.set(input.id, { ...input, status: "pending" });
      return true;
    },
  );
  const releaseCleanup = vi.fn(async (id: string, ownerUserId: string) => {
    const cleanup = cleanupJobs.get(id);
    if (cleanup?.ownerUserId === ownerUserId) {
      cleanup.runAfter = now;
    }
  });
  const commitCandidate = vi.fn(
    async (input: {
      record: ArtifactRecord;
      stagingCleanupJobId: string;
      replacementCleanupJobId: string;
    }) => {
      const existing = [...records.values()].find(
        (record) =>
          record.ownerUserId === input.record.ownerUserId &&
          record.sessionId === input.record.sessionId &&
          record.arkFileId === input.record.arkFileId,
      );
      const stagingCleanup = cleanupJobs.get(input.stagingCleanupJobId)!;
      if (existing && existing.deletionState !== "none") {
        stagingCleanup.runAfter = now;
        return { artifact: existing, activated: false };
      }
      const record: ArtifactRecord = {
        ...input.record,
        id: existing?.id ?? input.record.id,
        createdAt: existing?.createdAt ?? input.record.createdAt,
      };
      records.set(record.id, record);
      stagingCleanup.status = "succeeded";
      if (existing && existing.tosObjectKey !== record.tosObjectKey) {
        cleanupJobs.set(input.replacementCleanupJobId, {
          ownerUserId: record.ownerUserId,
          objectKey: existing.tosObjectKey,
          runAfter: now,
          status: "pending",
        });
      }
      return { artifact: record, activated: true };
    },
  );
  const repository: ArtifactRepository = {
    async findSessionOwned(ownerUserId, id) {
      return ownerUserId === userId && id === sessionId
        ? { id, arkSessionId: "ark-session-1" }
        : undefined;
    },
    async listInputFileIds(ownerUserId, sourceSessionId) {
      return ownerUserId === userId && sourceSessionId === sessionId
        ? ["ark-input-1"]
        : [];
    },
    async findBySource(ownerUserId, sourceSessionId, arkFileId) {
      return [...records.values()].find(
        (record) =>
          record.ownerUserId === ownerUserId &&
          record.sessionId === sourceSessionId &&
          record.arkFileId === arkFileId,
      );
    },
    stageCleanup,
    commitCandidate,
    releaseCleanup,
    async listOwned(ownerUserId, sourceSessionId) {
      return [...records.values()].filter(
        (record) =>
          record.ownerUserId === ownerUserId &&
          record.deletionState === "none" &&
          (!sourceSessionId || record.sessionId === sourceSessionId),
      );
    },
    async findOwned(ownerUserId, id) {
      const record = records.get(id);
      return record?.ownerUserId === ownerUserId ? record : undefined;
    },
    async beginDelete(id, ownerUserId) {
      const record = records.get(id);
      if (!record || record.ownerUserId !== ownerUserId) return undefined;
      const pending = { ...record, deletionState: "pending" as const };
      records.set(id, pending);
      return pending;
    },
    async findDeleting(ownerUserId, id) {
      const record = records.get(id);
      return record?.ownerUserId === ownerUserId &&
        (record.deletionState === "pending" ||
          record.deletionState === "deletion_failed")
        ? record
        : undefined;
    },
    async markDeleted(id, ownerUserId) {
      const record = records.get(id);
      if (!record || record.ownerUserId !== ownerUserId) return false;
      records.set(id, {
        ...record,
        name: "",
        mimeType: "application/octet-stream",
        sizeBytes: 0,
        deletionState: "deleted",
        lastErrorCode: null,
      });
      return true;
    },
  };
  const ark = {
    listArtifacts: vi.fn(async () => [
      exportEntry("ark-output-1", "report.txt", 5),
      // A Session input: same purpose, but recorded as an input for the Session.
      exportEntry("ark-input-1", "private.txt", 6),
      // Ark reported an export with no storage location, so it is unreachable.
      {
        id: "ark-unlocated-1",
        sessionId: "ark-session-1",
        name: "lost.txt",
        contentType: "text/plain",
        size: 0,
        createdAt: now.toISOString(),
        tos: null,
      },
      // Belongs to another Session and must never sync into this one.
      exportEntry("ark-other-session-1", "elsewhere.txt", 1, {
        sessionId: "ark-session-2",
      }),
    ]),
  };
  const storage = new InMemoryArtifactStorage();
  storage.putExternal(
    exportLocation("ark-output-1"),
    new TextEncoder().encode("hello"),
    "text/plain",
  );
  storage.putExternal(
    exportLocation("ark-input-1"),
    new TextEncoder().encode("secret"),
    "text/plain",
  );
  const service = new ArtifactService({
    repository,
    ark,
    storage,
    createId: () =>
      nextId++ === 0
        ? artifactId
        : `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`,
    objectKey: (input) =>
      `private/${input.ownerUserId}/${input.sessionId}/${input.arkFileId}/${
        (input as typeof input & { versionId?: string }).versionId
      }`,
  });
  return {
    service,
    repository,
    ark,
    storage,
    readExternal: vi.spyOn(storage, "readExternal"),
    records,
    stageCleanup,
    commitCandidate,
    releaseCleanup,
    cleanupJobs,
  };
}

describe("ArtifactService", () => {
  it("syncs only Session outputs and idempotently refreshes metadata", async () => {
    const state = setup();

    await expect(
      state.service.syncSession(sessionId, {
        userId,
        requestId: "request-1",
      }),
    ).resolves.toEqual([expect.objectContaining({ id: artifactId })]);
    state.ark.listArtifacts.mockResolvedValueOnce([
      exportEntry("ark-output-1", "report-renamed.txt", 7, {
        contentType: "text/markdown",
      }),
    ]);
    state.storage.putExternal(
      exportLocation("ark-output-1"),
      new TextEncoder().encode("updated"),
      "text/markdown",
    );

    const synced = await state.service.syncSession(sessionId, {
      userId,
      requestId: "request-2",
    });

    expect(synced).toEqual([
      expect.objectContaining({
        id: artifactId,
        name: "report-renamed.txt",
        mimeType: "text/markdown",
        sizeBytes: 7,
      }),
    ]);
    expect(state.records).toHaveLength(1);
    expect(state.readExternal).toHaveBeenCalledTimes(2);
    expect(
      await collect(
        await state.storage.openRead(
          [...state.records.values()][0]!.tosObjectKey,
        ),
      ),
    ).toEqual(new TextEncoder().encode("updated"));
  });

  it("rejects cross-tenant Session sync before calling Ark or storage", async () => {
    const state = setup();

    await expect(
      state.service.syncSession(sessionId, {
        userId: otherUserId,
        requestId: "request-1",
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);

    expect(state.ark.listArtifacts).not.toHaveBeenCalled();
    expect(state.storage.keys()).toEqual([]);
  });

  it("streams a large Ark artifact to storage with length and cancellation", async () => {
    const state = setup();
    const chunk = Buffer.alloc(1024 * 1024, 7);
    const chunkCount = 32;
    let produced = 0;
    const source = Readable.from(
      (async function* () {
        while (produced < chunkCount) {
          produced += 1;
          yield chunk;
        }
      })(),
    );
    const readExternal = vi.fn(async () => source);
    const controller = new AbortController();
    state.ark.listArtifacts.mockResolvedValueOnce([
      exportEntry("ark-output-1", "huge.bin", chunk.length * chunkCount, {
        contentType: "application/octet-stream",
      }),
    ]);
    const write = vi.fn(
      async (
        _key: string,
        stream: Readable,
        metadata: { contentType: string; contentLength?: number },
        signal?: AbortSignal,
      ) => {
        // The length comes from Ark's own metadata, not from the stream.
        expect(metadata.contentLength).toBe(chunk.length * chunkCount);
        expect(signal).toBe(controller.signal);
        let consumed = 0;
        for await (const value of stream) {
          consumed += Buffer.byteLength(value);
        }
        expect(consumed).toBe(chunk.length * chunkCount);
      },
    );
    const service = new ArtifactService({
      repository: state.repository,
      ark: state.ark,
      storage: {
        write,
        openRead: state.storage.openRead.bind(state.storage),
        readExternal,
        delete: state.storage.delete.bind(state.storage),
      },
      createId: () => artifactId,
    });

    await service.syncSession(sessionId, {
      userId,
      requestId: "request-large",
      signal: controller.signal,
    });

    expect(write).toHaveBeenCalledOnce();
    expect(produced).toBe(chunkCount);
    expect(readExternal).toHaveBeenCalledWith(
      exportLocation("ark-output-1"),
      controller.signal,
    );
  });

  it("cancels an in-flight Ark-to-storage transfer", async () => {
    const state = setup();
    const source = new Readable({ read() {} });
    const controller = new AbortController();
    const write = vi.fn(
      async (
        _key: string,
        stream: Readable,
        _metadata: unknown,
        signal?: AbortSignal,
      ) =>
        new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              stream.destroy();
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    const storage = {
      write,
      openRead: state.storage.openRead.bind(state.storage),
      readExternal: vi.fn(async () => source),
      delete: state.storage.delete.bind(state.storage),
    };
    const service = new ArtifactService({
      repository: state.repository,
      ark: state.ark,
      storage,
      createId: () => artifactId,
    });

    const sync = service.syncSession(sessionId, {
      userId,
      requestId: "request-cancel",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    controller.abort();

    await expect(sync).rejects.toMatchObject({ name: "AbortError" });
    expect(source.destroyed).toBe(true);
  });

  it("lists owned artifacts by source Session and proxies private bytes", async () => {
    const state = setup();
    await state.service.syncSession(sessionId, {
      userId,
      requestId: "request-1",
    });

    await expect(state.service.list(userId, sessionId)).resolves.toHaveLength(
      1,
    );
    await expect(state.service.list(otherUserId)).resolves.toEqual([]);
    const download = await state.service.download(artifactId, userId);
    expect(download).toMatchObject({
      name: "report.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
    });
    await expect(collect(download.stream)).resolves.toEqual(
      new TextEncoder().encode("hello"),
    );
    await expect(
      state.service.download(artifactId, otherUserId),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it("rejects cleanup of another tenant's private object key", async () => {
    const state = setup();
    const objectKey = `tenants/${userId}/sessions/${sessionId}/artifacts/file/version`;
    await state.storage.write(objectKey, Readable.from(["private"]), {
      contentType: "text/plain",
    });

    await expect(
      state.service.cleanupStoredObject(objectKey, otherUserId),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(state.storage.keys()).toContain(objectKey);
  });

  it("retains a hidden tombstone and prevents sequential sync resurrection", async () => {
    const state = setup();
    await state.service.syncSession(sessionId, {
      userId,
      requestId: "request-1",
    });

    await expect(
      state.service.requestDelete(artifactId, userId),
    ).resolves.toMatchObject({ deletionState: "pending" });
    await expect(
      state.service.requestDelete(artifactId, userId),
    ).resolves.toMatchObject({ deletionState: "pending" });

    await state.service.deleteStored(artifactId, userId);
    expect(state.storage.keys()).toEqual([]);
    expect(state.records.get(artifactId)).toMatchObject({
      ownerUserId: userId,
      sessionId,
      arkFileId: "ark-output-1",
      name: "",
      sizeBytes: 0,
      deletionState: "deleted",
    });
    await expect(state.service.list(userId)).resolves.toEqual([]);

    state.readExternal.mockClear();
    await expect(
      state.service.syncSession(sessionId, {
        userId,
        requestId: "request-after-delete",
      }),
    ).resolves.toEqual([]);
    expect(state.readExternal).not.toHaveBeenCalled();
    expect(state.storage.keys()).toEqual([]);
    await expect(
      state.service.deleteStored(artifactId, userId),
    ).resolves.toBeUndefined();
  });

  it("lets deletion win a controlled concurrent sync and removes its TOS write", async () => {
    const state = setup();
    await state.service.syncSession(sessionId, {
      userId,
      requestId: "request-initial",
    });

    let releaseWrite!: () => void;
    const writeReached = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let continueWrite!: () => void;
    const writeReleased = new Promise<void>((resolve) => {
      continueWrite = resolve;
    });
    const originalWrite = state.storage.write.bind(state.storage);
    state.storage.write = vi.fn(async (key, stream, metadata, signal) => {
      await originalWrite(key, stream, metadata, signal);
      releaseWrite();
      await writeReleased;
    });

    const sync = state.service.syncSession(sessionId, {
      userId,
      requestId: "request-racing-sync",
    });
    await writeReached;
    await state.service.requestDelete(artifactId, userId);
    continueWrite();

    await expect(sync).resolves.toEqual([]);
    expect(state.records.get(artifactId)?.deletionState).toBe("pending");
    expect(state.storage.keys()).toHaveLength(2);

    await state.service.deleteStored(artifactId, userId);
    expect(state.records.get(artifactId)?.deletionState).toBe("deleted");
    const stagedCleanup = [...state.cleanupJobs.values()].find(
      (cleanup) => cleanup.status === "pending",
    );
    expect(stagedCleanup).toBeDefined();
    await state.storage.delete(stagedCleanup!.objectKey);
    expect(state.storage.keys()).toEqual([]);
  });

  it("retains durable cleanup when initial persistence and cleanup release fail", async () => {
    const state = setup();
    state.repository.commitCandidate = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    state.repository.releaseCleanup = vi.fn(async () => {
      throw new Error("database still unavailable");
    });

    await expect(
      state.service.syncSession(sessionId, {
        userId,
        requestId: "request-failed-persistence",
      }),
    ).rejects.toThrow("database unavailable");
    expect(state.stageCleanup).toHaveBeenCalledOnce();
    expect(state.repository.releaseCleanup).toHaveBeenCalledOnce();
    expect([...state.cleanupJobs.values()]).toEqual([
      expect.objectContaining({ status: "pending" }),
    ]);
    expect(state.storage.keys()).toHaveLength(1);
  });

  it("preserves the indexed object when a refresh metadata swap fails", async () => {
    const state = setup();
    await state.service.syncSession(sessionId, {
      userId,
      requestId: "request-initial",
    });
    const indexed = state.records.get(artifactId)!;
    const oldKey = indexed.tosObjectKey;

    state.ark.listArtifacts.mockResolvedValueOnce([
      exportEntry("ark-output-1", "report.txt", 7),
    ]);
    state.storage.putExternal(
      exportLocation("ark-output-1"),
      new TextEncoder().encode("updated"),
      "text/plain",
    );
    state.repository.commitCandidate = vi.fn(async () => {
      throw new Error("database unavailable");
    });

    await expect(
      state.service.syncSession(sessionId, {
        userId,
        requestId: "request-refresh",
      }),
    ).rejects.toThrow("database unavailable");

    expect(state.records.get(artifactId)?.tosObjectKey).toBe(oldKey);
    await expect(
      collect(await state.storage.openRead(oldKey)),
    ).resolves.toEqual(new TextEncoder().encode("hello"));
    expect(state.storage.keys()).toHaveLength(2);
  });

  it("atomically schedules the old key for cleanup after a successful refresh", async () => {
    const state = setup();
    await state.service.syncSession(sessionId, {
      userId,
      requestId: "request-initial",
    });
    const oldKey = state.records.get(artifactId)!.tosObjectKey;

    await state.service.syncSession(sessionId, {
      userId,
      requestId: "request-refresh",
    });

    const oldKeyCleanup = [...state.cleanupJobs.values()].find(
      (cleanup) => cleanup.objectKey === oldKey && cleanup.status === "pending",
    );
    expect(oldKeyCleanup).toBeDefined();
    await state.storage.delete(oldKeyCleanup!.objectKey);
    expect(state.storage.keys()).toEqual([
      state.records.get(artifactId)!.tosObjectKey,
    ]);
  });

  it("releases staging cleanup instead of deleting inline when a tombstone wins", async () => {
    const state = setup();
    await state.service.syncSession(sessionId, {
      userId,
      requestId: "request-initial",
    });

    let releaseWrite!: () => void;
    const writeReached = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let continueWrite!: () => void;
    const writeReleased = new Promise<void>((resolve) => {
      continueWrite = resolve;
    });
    const originalWrite = state.storage.write.bind(state.storage);
    state.storage.write = vi.fn(async (key, stream, metadata, signal) => {
      await originalWrite(key, stream, metadata, signal);
      releaseWrite();
      await writeReleased;
    });

    const sync = state.service.syncSession(sessionId, {
      userId,
      requestId: "request-racing-sync",
    });
    await writeReached;
    await state.service.requestDelete(artifactId, userId);
    continueWrite();

    await expect(sync).resolves.toEqual([]);
    expect(state.commitCandidate).toHaveBeenCalled();
    expect(state.storage.keys()).toHaveLength(2);
  });
});

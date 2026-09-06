import { describe, expect, it, vi } from "vitest";
import { ArkGatewayError } from "../packages/ark-client/src/index.js";
import {
  InvalidUploadNameError,
  SessionInputService,
  type SessionInputRecord,
  type SessionInputRepository,
} from "../packages/domain/src/index.js";

const userId = "00000000-0000-4000-8000-000000000001";
const uploadId = "00000000-0000-4000-8000-000000000002";
const now = new Date("2026-09-06T00:00:00.000Z");

function setup() {
  const records = new Map<string, SessionInputRecord>();
  const repository: SessionInputRepository = {
    async prepareUpload(record) {
      records.set(record.id, record);
    },
    async completeUpload(id, ownerUserId, upstream) {
      const current = records.get(id);
      if (!current || current.ownerUserId !== ownerUserId) {
        throw new Error("missing");
      }
      const completed = {
        ...current,
        arkFileId: upstream.arkFileId,
        mimeType: upstream.mimeType,
        sizeBytes: upstream.sizeBytes,
        status: "uploaded" as const,
      };
      records.set(id, completed);
      return completed;
    },
    async failUpload(id, ownerUserId, errorCode) {
      const current = records.get(id);
      if (current?.ownerUserId === ownerUserId) {
        records.set(id, {
          ...current,
          status: "failed",
          lastErrorCode: errorCode,
        });
      }
    },
    async preserveUploadOutcome(id, ownerUserId, upstream) {
      const current = records.get(id);
      if (!current || current.ownerUserId !== ownerUserId) {
        throw new Error("missing");
      }
      records.set(id, {
        ...current,
        arkFileId: upstream.arkFileId,
        mimeType: upstream.mimeType,
        sizeBytes: upstream.sizeBytes,
        status: "uploaded",
        lastErrorCode: "DB_PERSISTENCE_FAILED",
      });
    },
    async findOwned(ownerUserId, id) {
      const record = records.get(id);
      return record?.ownerUserId === ownerUserId ? record : undefined;
    },
    async findExpiredUnbound() {
      return undefined;
    },
    async removeUnbound() {
      return false;
    },
  };
  const ark = {
    uploadFile: vi.fn(async () => ({
      id: "ark-file-1",
      name: "report.txt",
      contentType: "text/plain",
      size: 3,
      purpose: "agent" as const,
    })),
    deleteFile: vi.fn(async () => undefined),
  };
  const service = new SessionInputService({
    repository,
    ark,
    createId: () => uploadId,
    now: () => now,
    ttlMs: 60_000,
  });
  return { service, ark, records };
}

describe("SessionInputService", () => {
  it("uploads a sanitized tenant-owned temporary input for agent use", async () => {
    const state = setup();

    const uploaded = await state.service.upload(
      {
        name: "  quarterly report?.txt  ",
        contentType: "text/plain",
        bytes: new Uint8Array([1, 2, 3]),
      },
      { userId, requestId: "request-1" },
    );

    expect(state.ark.uploadFile).toHaveBeenCalledWith(
      {
        name: "quarterly_report_.txt",
        contentType: "text/plain",
        bytes: new Uint8Array([1, 2, 3]),
        purpose: "agent",
      },
      { correlationId: `upload:${uploadId}` },
    );
    expect(uploaded).toMatchObject({
      id: uploadId,
      ownerUserId: userId,
      arkFileId: "ark-file-1",
      originalName: "quarterly_report_.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      mountPath: `/mnt/session/inputs/${uploadId}-quarterly_report_.txt`,
      status: "uploaded",
      sessionId: null,
      lastErrorCode: null,
    });
    expect(uploaded.expiresAt.toISOString()).toBe("2026-09-06T00:01:00.000Z");
  });

  it.each([
    "../secret.txt",
    "folder/secret.txt",
    String.raw`folder\secret.txt`,
    ".",
    "..",
  ])(
    "rejects traversal or path-bearing filename %s before persistence",
    async (name) => {
      const state = setup();

      await expect(
        state.service.upload(
          {
            name,
            contentType: "text/plain",
            bytes: new Uint8Array([1]),
          },
          { userId, requestId: "request-1" },
        ),
      ).rejects.toBeInstanceOf(InvalidUploadNameError);

      expect(state.records.size).toBe(0);
      expect(state.ark.uploadFile).not.toHaveBeenCalled();
    },
  );

  it("retains a retryable failed record when Ark upload fails", async () => {
    const state = setup();
    state.ark.uploadFile.mockRejectedValueOnce(
      new ArkGatewayError("unknown_write_outcome"),
    );

    await expect(
      state.service.upload(
        {
          name: "report.txt",
          contentType: "text/plain",
          bytes: new Uint8Array([1]),
        },
        { userId, requestId: "request-1" },
      ),
    ).rejects.toMatchObject({ category: "unknown_write_outcome" });

    expect(state.records.get(uploadId)).toMatchObject({
      ownerUserId: userId,
      status: "failed",
      lastErrorCode: "ARK_UNKNOWN_WRITE_OUTCOME",
      sessionId: null,
    });
  });

  it("preserves the Ark file identity when local completion fails", async () => {
    const state = setup();
    const repository = (
      state.service as unknown as {
        dependencies: { repository: SessionInputRepository };
      }
    ).dependencies.repository;
    vi.spyOn(repository, "completeUpload").mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    await expect(
      state.service.upload(
        {
          name: "report.txt",
          contentType: "text/plain",
          bytes: new Uint8Array([1]),
        },
        { userId, requestId: "request-1" },
      ),
    ).rejects.toThrow("database unavailable");

    expect(state.records.get(uploadId)).toMatchObject({
      arkFileId: "ark-file-1",
      status: "uploaded",
      lastErrorCode: "DB_PERSISTENCE_FAILED",
    });
  });

  it("deletes an expired unbound upload upstream before removing its record", async () => {
    const state = setup();
    const uploaded = await state.service.upload(
      {
        name: "report.txt",
        contentType: "text/plain",
        bytes: new Uint8Array([1]),
      },
      { userId, requestId: "request-1" },
    );
    const order: string[] = [];
    state.ark.deleteFile.mockImplementationOnce(async () => {
      order.push("upstream");
    });
    const repository = (
      state.service as unknown as {
        dependencies: { repository: SessionInputRepository };
      }
    ).dependencies.repository;
    repository.findExpiredUnbound = async () => uploaded;
    repository.removeUnbound = async () => {
      order.push("local");
      state.records.delete(uploadId);
      return true;
    };

    await state.service.cleanupExpired(uploadId, {
      userId,
      requestId: "worker-1",
    });

    expect(state.ark.deleteFile).toHaveBeenCalledWith("ark-file-1", {
      correlationId: "worker-1",
    });
    expect(order).toEqual(["upstream", "local"]);
    expect(state.records.has(uploadId)).toBe(false);
  });

  it("removes expired uploads without an Ark identity locally", async () => {
    const state = setup();
    const input: SessionInputRecord = {
      id: uploadId,
      ownerUserId: userId,
      sessionId: null,
      arkFileId: null,
      originalName: "report.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      mountPath: `/mnt/session/inputs/${uploadId}-report.txt`,
      status: "uploading",
      expiresAt: now,
      lastErrorCode: null,
      createdAt: now,
      updatedAt: now,
    };
    const repository = (
      state.service as unknown as {
        dependencies: { repository: SessionInputRepository };
      }
    ).dependencies.repository;
    repository.findExpiredUnbound = async () => input;
    repository.removeUnbound = async () => true;

    await state.service.cleanupExpired(uploadId, {
      userId,
      requestId: "worker-1",
    });

    expect(state.ark.deleteFile).not.toHaveBeenCalled();
  });

  it("fails cleanup when the expired local upload remains", async () => {
    const state = setup();
    const input: SessionInputRecord = {
      id: uploadId,
      ownerUserId: userId,
      sessionId: null,
      arkFileId: null,
      originalName: "report.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      mountPath: `/mnt/session/inputs/${uploadId}-report.txt`,
      status: "failed",
      expiresAt: now,
      lastErrorCode: "ARK_UNAVAILABLE",
      createdAt: now,
      updatedAt: now,
    };
    const repository = (
      state.service as unknown as {
        dependencies: { repository: SessionInputRepository };
      }
    ).dependencies.repository;
    repository.findExpiredUnbound = async () => input;
    repository.removeUnbound = async () => false;

    await expect(
      state.service.cleanupExpired(uploadId, {
        userId,
        requestId: "worker-1",
      }),
    ).rejects.toThrow("Expired upload was not removed");
  });

  it("does not delete bound, foreign, or already removed uploads upstream", async () => {
    const state = setup();

    await state.service.cleanupExpired(uploadId, {
      userId,
      requestId: "worker-1",
    });

    expect(state.ark.deleteFile).not.toHaveBeenCalled();
  });
});

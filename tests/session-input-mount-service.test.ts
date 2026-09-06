import { describe, expect, it, vi } from "vitest";
import { ArkGatewayError } from "../packages/ark-client/src/index.js";
import {
  ResourceNotFoundError,
  SessionService,
  type SessionInputRecord,
  type SessionRecord,
  type SessionRepository,
} from "../packages/domain/src/index.js";

const userId = "00000000-0000-4000-8000-000000000001";
const otherUserId = "00000000-0000-4000-8000-000000000002";
const agentId = "00000000-0000-4000-8000-000000000003";
const sessionId = "00000000-0000-4000-8000-000000000004";
const uploadId = "00000000-0000-4000-8000-000000000005";
const now = new Date("2026-09-06T00:00:00.000Z");

function setup(uploadOwner = userId) {
  let record: SessionRecord | undefined;
  const input: SessionInputRecord = {
    id: uploadId,
    ownerUserId: uploadOwner,
    sessionId: null,
    arkFileId: "ark-file-1",
    originalName: "brief.txt",
    mimeType: "text/plain",
    sizeBytes: 3,
    mountPath: `/mnt/session/inputs/${uploadId}-brief.txt`,
    status: "uploaded",
    expiresAt: new Date("2026-09-07T00:00:00.000Z"),
    lastErrorCode: null,
    createdAt: now,
    updatedAt: now,
  };
  const repository: SessionRepository = {
    async prepareCreate(intent, uploadIds) {
      if (
        uploadIds.some(
          (id) =>
            id !== input.id ||
            input.ownerUserId !== intent.ownerUserId ||
            input.sessionId !== null ||
            input.status !== "uploaded",
        )
      ) {
        throw new ResourceNotFoundError();
      }
      record = intent;
      if (uploadIds.includes(input.id)) input.sessionId = intent.id;
      return uploadIds.includes(input.id) ? [input] : [];
    },
    async completeCreate(id, ownerUserId, upstream) {
      if (!record || record.id !== id || record.ownerUserId !== ownerUserId) {
        throw new Error("missing");
      }
      record = { ...record, ...upstream };
      if (input.sessionId === id) input.status = "bound";
      return record;
    },
    async preserveCreateOutcome(_id, _ownerUserId, upstream) {
      if (record && upstream) record = { ...record, ...upstream };
    },
    async failCreate() {
      record = undefined;
    },
    async listOwned() {
      return record ? [record] : [];
    },
    async findOwned(ownerUserId, id) {
      return record?.ownerUserId === ownerUserId && record.id === id
        ? record
        : undefined;
    },
    async findCreateIntent(ownerUserId, id) {
      return record?.ownerUserId === ownerUserId && record.id === id
        ? record
        : undefined;
    },
    async listInputs(ownerUserId, id) {
      return input.ownerUserId === ownerUserId && input.sessionId === id
        ? [input]
        : [];
    },
    async beginMessage() {
      return undefined;
    },
    async finishMessage() {},
    async projectEvent() {},
    async audit() {},
  };
  const ark = {
    createSession: vi.fn(async () => ({
      id: "ark-session-1",
      agentId: "ark-agent-1",
      agentVersion: 7,
      environmentId: "environment-1",
      status: "idle" as const,
    })),
    getSession: vi.fn(async () => ({
      id: "ark-session-1",
      agentId: "ark-agent-1",
      agentVersion: 7,
      environmentId: "environment-1",
      status: "idle" as const,
    })),
    submitEvent: vi.fn(),
    listEvents: vi.fn(),
    streamEvents: vi.fn(),
  };
  const service = new SessionService({
    repository,
    agentResolver: {
      async resolveForNewSession() {
        return {
          id: agentId,
          arkAgentId: "ark-agent-1",
          name: "Agent",
          description: "",
          modelId: "model-a",
          systemPrompt: "",
          arkVersion: "7",
          status: "active",
          kind: "personal",
          editable: true,
        };
      },
    },
    ark,
    environmentId: "environment-1",
    createId: () => sessionId,
    now: () => now,
  });
  return { service, ark, input, getRecord: () => record };
}

describe("Session input mounting", () => {
  it("reserves owned uploads, mounts them, and atomically marks them bound", async () => {
    const state = setup();

    await state.service.create(
      { agentId, uploadIds: [uploadId] },
      { userId, requestId: "request-1" },
    );

    expect(state.ark.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        resources: [
          {
            fileId: "ark-file-1",
            mountPath: `/mnt/session/inputs/${uploadId}-brief.txt`,
          },
        ],
      }),
      expect.any(Object),
    );
    expect(state.input).toMatchObject({
      sessionId,
      status: "bound",
    });
  });

  it("rejects another tenant's upload before calling Ark", async () => {
    const state = setup(otherUserId);

    await expect(
      state.service.create(
        { agentId, uploadIds: [uploadId] },
        { userId, requestId: "request-1" },
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);

    expect(state.ark.createSession).not.toHaveBeenCalled();
    expect(state.getRecord()).toBeUndefined();
  });

  it("keeps mounts reserved and reuses them after an Ark mount failure", async () => {
    const state = setup();
    state.ark.createSession.mockRejectedValueOnce(
      new ArkGatewayError("rate_limited"),
    );

    await expect(
      state.service.create(
        { agentId, uploadIds: [uploadId] },
        { userId, requestId: "request-1" },
      ),
    ).rejects.toMatchObject({ category: "rate_limited" });

    expect(state.input).toMatchObject({
      sessionId,
      status: "uploaded",
    });
    expect(state.getRecord()?.arkSessionId).toBe(`pending:${sessionId}`);

    await state.service.reconcileCreate(sessionId, {
      userId,
      requestId: "worker-1",
    });
    expect(state.ark.createSession).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resources: [
          expect.objectContaining({
            fileId: "ark-file-1",
            mountPath: `/mnt/session/inputs/${uploadId}-brief.txt`,
          }),
        ],
      }),
      expect.any(Object),
    );
    expect(state.input.status).toBe("bound");
  });

  it("returns inputs only with owned Session detail", async () => {
    const state = setup();
    await state.service.create(
      { agentId, uploadIds: [uploadId] },
      { userId, requestId: "request-1" },
    );

    await expect(state.service.get(userId, sessionId)).resolves.toMatchObject({
      id: sessionId,
      inputs: [
        {
          id: uploadId,
          originalName: "brief.txt",
          mountPath: `/mnt/session/inputs/${uploadId}-brief.txt`,
        },
      ],
    });
    await expect(
      state.service.get(otherUserId, sessionId),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

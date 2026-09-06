import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { Readable } from "node:stream";
import type { ArkGateway } from "@pwa/ark-client";
import { ResourceNotFoundError } from "./errors.js";

export type ArtifactDeletionState =
  "none" | "pending" | "deletion_failed" | "deleted";

export interface ArtifactRecord {
  id: string;
  ownerUserId: string;
  sessionId: string;
  arkFileId: string;
  tosObjectKey: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  generatedAt: Date;
  deletionState: ArtifactDeletionState;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ArtifactRepository {
  findSessionOwned(
    userId: string,
    sessionId: string,
  ): PromiseLike<{ id: string; arkSessionId: string } | undefined>;
  findBySource(
    userId: string,
    sessionId: string,
    arkFileId: string,
  ): PromiseLike<ArtifactRecord | undefined>;
  stageCleanup(input: {
    id: string;
    ownerUserId: string;
    objectKey: string;
    runAfter: Date;
  }): PromiseLike<void>;
  commitCandidate(input: {
    record: ArtifactRecord;
    stagingCleanupJobId: string;
    replacementCleanupJobId: string;
  }): PromiseLike<{ artifact: ArtifactRecord; activated: boolean }>;
  releaseCleanup(id: string, userId: string): PromiseLike<void>;
  listOwned(userId: string, sessionId?: string): PromiseLike<ArtifactRecord[]>;
  findOwned(
    userId: string,
    id: string,
  ): PromiseLike<ArtifactRecord | undefined>;
  beginDelete(
    id: string,
    userId: string,
  ): PromiseLike<ArtifactRecord | undefined>;
  findDeleting(
    userId: string,
    id: string,
  ): PromiseLike<ArtifactRecord | undefined>;
  markDeleted(id: string, userId: string): PromiseLike<boolean>;
}

export interface ArtifactStorage {
  write(
    objectKey: string,
    stream: Readable,
    metadata: { contentType: string; contentLength?: number },
    signal?: AbortSignal,
  ): PromiseLike<void>;
  openRead(objectKey: string, signal?: AbortSignal): PromiseLike<Readable>;
  delete(objectKey: string): PromiseLike<void>;
}

interface ArtifactContext {
  userId: string;
  requestId: string;
  signal?: AbortSignal;
}

function defaultObjectKey(input: {
  ownerUserId: string;
  sessionId: string;
  arkFileId: string;
  versionId: string;
}): string {
  const digest = createHash("sha256").update(input.arkFileId).digest("hex");
  return `tenants/${input.ownerUserId}/sessions/${input.sessionId}/artifacts/${digest}/${input.versionId}`;
}

export class ArtifactService {
  constructor(
    private readonly dependencies: {
      repository: ArtifactRepository;
      ark: Pick<ArkGateway, "listArtifacts" | "downloadFile">;
      storage: ArtifactStorage;
      createId: () => string;
      objectKey?: (input: {
        ownerUserId: string;
        sessionId: string;
        arkFileId: string;
        versionId: string;
      }) => string;
      now?: () => Date;
    },
  ) {}

  async syncSession(
    sessionId: string,
    context: ArtifactContext,
  ): Promise<ArtifactRecord[]> {
    const session = await this.dependencies.repository.findSessionOwned(
      context.userId,
      sessionId,
    );
    if (!session) throw new ResourceNotFoundError();

    const upstream = await this.dependencies.ark.listArtifacts(
      session.arkSessionId,
      {
        correlationId: context.requestId,
        ...(context.signal ? { signal: context.signal } : {}),
      },
    );
    const outputs = upstream.filter(
      (artifact) =>
        artifact.sessionId === session.arkSessionId &&
        posix.normalize(artifact.mountPath).startsWith("/mnt/session/outputs/"),
    );
    const synced: ArtifactRecord[] = [];
    for (const artifact of outputs) {
      const existing = await this.dependencies.repository.findBySource(
        context.userId,
        sessionId,
        artifact.id,
      );
      if (existing && existing.deletionState !== "none") continue;

      const recordId = existing?.id ?? this.dependencies.createId();
      const stagingCleanupJobId = this.dependencies.createId();
      const tosObjectKey = (this.dependencies.objectKey ?? defaultObjectKey)({
        ownerUserId: context.userId,
        sessionId,
        arkFileId: artifact.id,
        versionId: stagingCleanupJobId,
      });
      const timestamp = (this.dependencies.now ?? (() => new Date()))();
      await this.dependencies.repository.stageCleanup({
        id: stagingCleanupJobId,
        ownerUserId: context.userId,
        objectKey: tosObjectKey,
        runAfter: new Date(timestamp.getTime() + 24 * 60 * 60 * 1_000),
      });
      try {
        const download = await this.dependencies.ark.downloadFile(artifact.id, {
          correlationId: context.requestId,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        await this.dependencies.storage.write(
          tosObjectKey,
          download.stream,
          {
            contentType: artifact.contentType,
            contentLength: download.contentLength ?? artifact.size,
          },
          context.signal,
        );
        const committed = await this.dependencies.repository.commitCandidate({
          record: {
            id: recordId,
            ownerUserId: context.userId,
            sessionId,
            arkFileId: artifact.id,
            tosObjectKey,
            name: artifact.name,
            mimeType: artifact.contentType,
            sizeBytes: artifact.size,
            generatedAt: new Date(artifact.createdAt),
            deletionState: "none",
            lastErrorCode: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          stagingCleanupJobId,
          replacementCleanupJobId: this.dependencies.createId(),
        });
        if (!committed.activated) continue;
        synced.push(committed.artifact);
      } catch (error) {
        try {
          await this.dependencies.repository.releaseCleanup(
            stagingCleanupJobId,
            context.userId,
          );
        } catch {
          // The delayed cleanup intent was persisted before the upload.
        }
        throw error;
      }
    }
    return synced;
  }

  list(userId: string, sessionId?: string): PromiseLike<ArtifactRecord[]> {
    return this.dependencies.repository.listOwned(userId, sessionId);
  }

  async download(
    id: string,
    userId: string,
    signal?: AbortSignal,
  ): Promise<{
    name: string;
    mimeType: string;
    sizeBytes: number;
    stream: Readable;
  }> {
    const artifact = await this.dependencies.repository.findOwned(userId, id);
    if (!artifact || artifact.deletionState !== "none") {
      throw new ResourceNotFoundError();
    }
    return {
      name: artifact.name,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes,
      stream: await this.dependencies.storage.openRead(
        artifact.tosObjectKey,
        signal,
      ),
    };
  }

  async requestDelete(id: string, userId: string): Promise<ArtifactRecord> {
    const artifact = await this.dependencies.repository.beginDelete(id, userId);
    if (!artifact) throw new ResourceNotFoundError();
    return artifact;
  }

  async cleanupStoredObject(objectKey: string, userId: string): Promise<void> {
    if (
      posix.normalize(objectKey) !== objectKey ||
      !objectKey.startsWith(`tenants/${userId}/sessions/`)
    ) {
      throw new ResourceNotFoundError();
    }
    await this.dependencies.storage.delete(objectKey);
  }

  async deleteStored(id: string, userId: string): Promise<void> {
    const artifact = await this.dependencies.repository.findDeleting(
      userId,
      id,
    );
    if (!artifact) return;
    await this.dependencies.storage.delete(artifact.tosObjectKey);
    const removed = await this.dependencies.repository.markDeleted(id, userId);
    if (!removed) throw new Error("Artifact index was not removed");
  }
}

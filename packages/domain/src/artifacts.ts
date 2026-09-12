import { posix } from "node:path";
import type { Readable } from "node:stream";
import type { ArkArtifact, ArkGateway, ArkTosLocation } from "@pwa/ark-client";
import { ResourceNotFoundError } from "./errors.js";
import type { DriveFileRecord, DriveFileService } from "./drive-files.js";

export type ArtifactDeletionState =
  "none" | "pending" | "deletion_failed" | "deleted";

/**
 * A Session's association with one output file. The bytes are owned by a
 * `drive_files` row (`driveFileId`); this row records that *this Session*
 * produced that file. Deleting the Session drops the association, not the
 * bytes, which is what lets a future drive mode keep the file.
 *
 * `tosObjectKey` is carried here only as a convenience for callers that need to
 * stream the bytes; it belongs to the drive row and is joined in on read.
 */
export interface ArtifactRecord {
  id: string;
  ownerUserId: string;
  sessionId: string;
  arkFileId: string;
  driveFileId: string;
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
  /**
   * Uploaded inputs are Ark files too. Ark scopes them the same way as exports
   * in some cases, so the Session's own inputs are excluded by id rather than
   * trusted to the export filter.
   */
  listInputFileIds?(userId: string, sessionId: string): PromiseLike<string[]>;
  findBySource(
    userId: string,
    sessionId: string,
    arkFileId: string,
  ): PromiseLike<ArtifactRecord | undefined>;
  /** Inserts or refreshes the Session→drive-file association. */
  upsertAssociation(record: ArtifactRecord): PromiseLike<ArtifactRecord>;
  listOwned(userId: string, sessionId?: string): PromiseLike<ArtifactRecord[]>;
  findOwned(
    userId: string,
    id: string,
  ): PromiseLike<ArtifactRecord | undefined>;
  requestDelete(
    id: string,
    userId: string,
    at: Date,
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
  readExternal(
    input: { bucket: string; objectKey: string },
    signal?: AbortSignal,
  ): PromiseLike<Readable>;
  delete(objectKey: string): PromiseLike<void>;
}

interface ArtifactContext {
  userId: string;
  requestId: string;
  signal?: AbortSignal;
}

export class ArtifactService {
  constructor(
    private readonly dependencies: {
      repository: ArtifactRepository;
      drive: Pick<
        DriveFileService,
        "createFromSource" | "refreshFromSource" | "findOwned"
      >;
      ark: Pick<ArkGateway, "listArtifacts">;
      storage: ArtifactStorage;
      createId: () => string;
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
    const inputFileIds = new Set(
      (await this.dependencies.repository.listInputFileIds?.(
        context.userId,
        sessionId,
      )) ?? [],
    );
    // An export with no TOS location has no reachable bytes; Ark's Files API
    // has no content endpoint, so there is nothing to copy.
    const outputs = upstream.filter(
      (artifact): artifact is ArkArtifact & { tos: ArkTosLocation } =>
        artifact.sessionId === session.arkSessionId &&
        artifact.tos !== null &&
        !inputFileIds.has(artifact.id),
    );
    const synced: ArtifactRecord[] = [];
    for (const artifact of outputs) {
      const existing = await this.dependencies.repository.findBySource(
        context.userId,
        sessionId,
        artifact.id,
      );
      if (existing && existing.deletionState !== "none") continue;

      let drive: DriveFileRecord | null | undefined;
      if (existing) {
        const current = await this.dependencies.drive.findOwned(
          context.userId,
          existing.driveFileId,
        );
        if (current && current.deletionState === "none") {
          drive = await this.dependencies.drive.refreshFromSource(
            current,
            artifact.tos,
            context,
          );
        }
      }
      if (!drive) {
        drive = await this.dependencies.drive.createFromSource(
          {
            ownerUserId: context.userId,
            origin: "artifact",
            name: artifact.name,
            mimeType: artifact.contentType,
            sizeBytes: artifact.size,
            source: artifact.tos,
            sourceSessionId: sessionId,
          },
          context,
        );
        // The Session began deleting mid-sync; skip rather than write an
        // association the deletion pass will not see.
        if (!drive) continue;
      }

      const timestamp = (this.dependencies.now ?? (() => new Date()))();
      const association = await this.dependencies.repository.upsertAssociation({
        id: existing?.id ?? this.dependencies.createId(),
        ownerUserId: context.userId,
        sessionId,
        arkFileId: artifact.id,
        driveFileId: drive.id,
        tosObjectKey: drive.tosObjectKey,
        name: artifact.name,
        mimeType: artifact.contentType,
        sizeBytes: artifact.size,
        generatedAt: new Date(artifact.createdAt),
        deletionState: "none",
        lastErrorCode: null,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
      synced.push(association);
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
    const at = (this.dependencies.now ?? (() => new Date()))();
    const artifact = await this.dependencies.repository.requestDelete(
      id,
      userId,
      at,
    );
    if (!artifact) throw new ResourceNotFoundError();
    return artifact;
  }

  /**
   * Deletes a drive object's bytes and tombstones the association. The bytes
   * belong to the drive row, so removal goes through the same storage call a
   * drive-level delete would use.
   */
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

  /**
   * Legacy cleanup path for `cleanup_artifact_object` jobs created before the
   * drive layer existed. New flows never produce them; this drains the back-log.
   */
  async cleanupStoredObject(objectKey: string, userId: string): Promise<void> {
    if (
      posix.normalize(objectKey) !== objectKey ||
      !objectKey.startsWith(`tenants/${userId}/`)
    ) {
      throw new ResourceNotFoundError();
    }
    await this.dependencies.storage.delete(objectKey);
  }
}

import type { Readable } from "node:stream";
import { ResourceNotFoundError } from "./errors.js";
import { driveObjectKey } from "./storage-keys.js";

export type FileOrigin = "upload" | "artifact" | "import";

export type DriveFileDeletionState =
  "none" | "pending" | "deletion_failed" | "deleted";

/**
 * The byte object a user's drive owns. One row per stored object. Its
 * `tosObjectKey` is the only authoritative location for the bytes; Sessions
 * reference it through associations (`artifacts`) rather than owning it.
 */
export interface DriveFileRecord {
  id: string;
  ownerUserId: string;
  origin: FileOrigin;
  tosObjectKey: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  contentHash: string | null;
  sourceSessionId: string | null;
  folderId: string | null;
  deletionState: DriveFileDeletionState;
  writeLeaseUntil: Date | null;
  orphanedAt: Date | null;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DriveFileRepository {
  /**
   * Reserves a row and a cleanup intent before any bytes are written, so a
   * crash between "start writing" and "commit" still leaves a durable intent to
   * delete the partial object.
   */
  stage(input: {
    id: string;
    ownerUserId: string;
    origin: FileOrigin;
    objectKey: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    contentHash?: string;
    sourceSessionId?: string;
    runAfter: Date;
    writeLeaseUntil: Date;
  }): PromiseLike<boolean>;
  /** Commits staged bytes; artifact copies retain cleanup until association activation. */
  commit(input: {
    id: string;
    ownerUserId: string;
    signal?: AbortSignal;
  }): PromiseLike<{ record: DriveFileRecord; activated: boolean }>;
  /** Re-arms the cleanup intent after a failed write so the object is reaped. */
  release(id: string, ownerUserId: string): PromiseLike<void>;
  findOwned(
    ownerUserId: string,
    id: string,
  ): PromiseLike<DriveFileRecord | undefined>;
  /**
   * Atomically repoints a live, non-orphaned row at freshly written bytes.
   * Returns the updated record, or undefined when the row is being deleted
   * or already orphaned (the caller must then reclaim the new bytes).
   */
  switchObjectKey(
    id: string,
    ownerUserId: string,
    input: {
      objectKey: string;
      mimeType: string;
      sizeBytes: number;
      contentHash?: string;
      signal?: AbortSignal;
    },
  ): PromiseLike<DriveFileRecord | undefined>;
  /** Marks the bytes unreferenced; the GC reaps them after the retention. */
  orphan(id: string, ownerUserId: string, at: Date): PromiseLike<boolean>;
  /**
   * Selects committed, unreferenced rows past the retention window and hands
   * them to the cleanup job. Returns how many were enqueued.
   */
  claimOrphans(input: {
    limit: number;
    retentionMs: number;
    now: Date;
  }): PromiseLike<number>;
  markDeleted(id: string, ownerUserId: string): PromiseLike<boolean>;
  markDeletionFailed?(
    id: string,
    ownerUserId: string,
    errorCode: string,
  ): PromiseLike<void>;
}

export interface DriveFileStorage {
  write(
    objectKey: string,
    stream: Readable,
    metadata: { contentType: string; contentLength?: number },
    signal?: AbortSignal,
  ): PromiseLike<void>;
  readExternal(
    input: { bucket: string; objectKey: string },
    signal?: AbortSignal,
  ): PromiseLike<Readable>;
  delete(objectKey: string): PromiseLike<void>;
}

interface DriveContext {
  userId: string;
  requestId: string;
  signal?: AbortSignal;
}

/**
 * Owns the lifetime of a user's byte objects: reserving them before a write,
 * committing after, and reaping them once nothing references them. Artifact and
 * (later) upload flows go through this service instead of touching TOS keys
 * directly, so the "who owns these bytes" question has exactly one answer.
 */
export class DriveFileService {
  constructor(
    private readonly dependencies: {
      repository: DriveFileRepository;
      storage: DriveFileStorage;
      createId: () => string;
      /**
       * Enqueues the legacy key-addressed cleanup for a retired object key.
       * Optional so pure service tests can omit it; production wires it to
       * the job queue.
       */
      enqueueLegacyKeyCleanup?: (
        objectKey: string,
        ownerUserId: string,
      ) => PromiseLike<void>;
      now?: () => Date;
      writeLeaseMs?: number;
      stagingRetentionMs?: number;
    },
  ) {}

  private get now(): () => Date {
    return this.dependencies.now ?? (() => new Date());
  }

  /**
   * Copies an upstream object (an Ark export parked in TOS) into the user's
   * drive, returning the committed row. Crashes are safe: the reservation and
   * its cleanup intent are persisted before the first byte is read.
   *
   * Returns null when the owning Session is already deleting — the caller
   * should skip the file rather than write bytes the deletion pass will not
   * reclaim.
   */
  async createFromSource(
    input: {
      ownerUserId: string;
      origin: FileOrigin;
      name: string;
      mimeType: string;
      sizeBytes: number;
      source: { bucket: string; objectKey: string };
      sourceSessionId?: string;
      contentHash?: string;
    },
    context: DriveContext,
  ): Promise<DriveFileRecord | null> {
    const id = this.dependencies.createId();
    const objectKey = driveObjectKey({
      ownerUserId: input.ownerUserId,
      origin: input.origin,
      driveFileId: id,
      name: input.name,
    });
    const timestamp = this.now();
    const staged = await this.dependencies.repository.stage({
      id,
      ownerUserId: input.ownerUserId,
      origin: input.origin,
      objectKey,
      name: input.name,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      ...(input.contentHash === undefined
        ? {}
        : { contentHash: input.contentHash }),
      ...(input.sourceSessionId === undefined
        ? {}
        : { sourceSessionId: input.sourceSessionId }),
      runAfter: new Date(
        timestamp.getTime() +
          (this.dependencies.stagingRetentionMs ?? 24 * 60 * 60 * 1_000),
      ),
      writeLeaseUntil: new Date(
        timestamp.getTime() +
          (this.dependencies.writeLeaseMs ?? 5 * 60 * 1_000),
      ),
    });
    if (!staged) return null;
    try {
      const stream = await this.dependencies.storage.readExternal(
        input.source,
        context.signal,
      );
      await this.dependencies.storage.write(
        objectKey,
        stream,
        { contentType: input.mimeType, contentLength: input.sizeBytes },
        context.signal,
      );
      const committed = await this.dependencies.repository.commit({
        id,
        ownerUserId: input.ownerUserId,
        ...(context.signal ? { signal: context.signal } : {}),
      });
      if (!committed.activated) {
        // The Session began deleting mid-flight. Re-arm the staging intent so
        // the object we just wrote is reclaimed promptly, then report "skip".
        try {
          await this.dependencies.repository.release(id, input.ownerUserId);
        } catch {
          // The intent survives with its original schedule either way.
        }
        return null;
      }
      return committed.record;
    } catch (error) {
      try {
        await this.dependencies.repository.release(id, input.ownerUserId);
      } catch {
        // The delayed cleanup intent was persisted before the upload, so a
        // failed re-arm still leaves the object reclaimable.
      }
      throw error;
    }
  }

  /**
   * Re-copies an already-committed drive object from its source. The bytes
   * land under a fresh operation-scoped key and the row is switched
   * atomically: readers and the cleanup path keep seeing a complete object
   * under the old key until the switch commits, and a row that entered
   * deletion or orphaning mid-copy is left untouched (the fresh bytes are
   * reclaimed instead).
   */
  async refreshFromSource(
    record: DriveFileRecord,
    source: {
      bucket: string;
      objectKey: string;
      mimeType?: string;
      sizeBytes?: number;
    },
    context: DriveContext,
  ): Promise<DriveFileRecord> {
    const operationId = this.dependencies.createId();
    const nextKey = driveObjectKey({
      ownerUserId: record.ownerUserId,
      origin: record.origin,
      driveFileId: `${record.id}/r${operationId}`,
      name: record.name,
    });
    const mimeType = source.mimeType ?? record.mimeType;
    const sizeBytes = source.sizeBytes ?? record.sizeBytes;
    const stream = await this.dependencies.storage.readExternal(
      source,
      context.signal,
    );
    await this.dependencies.storage.write(
      nextKey,
      stream,
      { contentType: mimeType, contentLength: sizeBytes },
      context.signal,
    );
    if (context.signal?.aborted) {
      await this.dependencies.storage.delete(nextKey);
      context.signal.throwIfAborted();
    }
    let switched: DriveFileRecord | undefined;
    try {
      switched = await this.dependencies.repository.switchObjectKey(
        record.id,
        record.ownerUserId,
        {
          objectKey: nextKey,
          mimeType,
          sizeBytes,
          ...(context.signal ? { signal: context.signal } : {}),
        },
      );
    } catch (error) {
      await this.dependencies.enqueueLegacyKeyCleanup?.(
        nextKey,
        record.ownerUserId,
      );
      throw error;
    }
    if (!switched) {
      // The row is being deleted or was orphaned while we copied: the new
      // bytes are unreferenced garbage, the old row owns its own lifecycle.
      await this.dependencies.storage.delete(nextKey);
      return record;
    }
    // The old key lost its only reference with the switch; hand it to the
    // legacy key-addressed cleanup, whose guard proves it has no row.
    await this.dependencies.enqueueLegacyKeyCleanup?.(
      record.tosObjectKey,
      record.ownerUserId,
    );
    return switched;
  }

  findOwned(
    ownerUserId: string,
    id: string,
  ): PromiseLike<DriveFileRecord | undefined> {
    return this.dependencies.repository.findOwned(ownerUserId, id);
  }

  /** Marks the object unreferenced so the GC can reap it after retention. */
  async orphan(id: string, ownerUserId: string): Promise<void> {
    const changed = await this.dependencies.repository.orphan(
      id,
      ownerUserId,
      this.now(),
    );
    if (!changed) throw new ResourceNotFoundError();
  }

  /**
   * Deletes a drive object's bytes. Used by the cleanup job for both abandoned
   * staged writes and reaped orphans. Idempotent: a missing object is success.
   */
  async deleteStored(id: string, ownerUserId: string): Promise<void> {
    const record = await this.dependencies.repository.findOwned(
      ownerUserId,
      id,
    );
    if (!record || record.deletionState === "deleted") return;
    await this.dependencies.storage.delete(record.tosObjectKey);
    const removed = await this.dependencies.repository.markDeleted(
      id,
      ownerUserId,
    );
    if (!removed) throw new Error("Drive file index was not removed");
  }

  /** Enqueues cleanup for orphaned objects past the retention window. */
  reapOrphans(input: {
    limit: number;
    retentionMs: number;
  }): PromiseLike<number> {
    return this.dependencies.repository.claimOrphans({
      limit: input.limit,
      retentionMs: input.retentionMs,
      now: this.now(),
    });
  }
}

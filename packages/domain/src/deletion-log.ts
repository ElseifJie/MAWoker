import { Readable } from "node:stream";

/**
 * Append-only intent log for irreversible deletions, stored OUTSIDE the
 * business database so a backup restore cannot resurrect content the user
 * asked to delete. Entries carry identity, scope, epoch and time only —
 * never conversation text, tokens or secrets.
 */
export interface DeletionLogIntent {
  kind: "session";
  deletionRequestId: string;
  userId: string;
  sessionId: string;
  arkSessionId: string;
  scope: "session_history_and_artifacts";
  requestedAt: string;
}

/** The protected prefix the deployment must isolate from business data. */
export const DELETION_LOG_PREFIX = "deletion-log";

interface DeletionLogStorage {
  write(
    objectKey: string,
    stream: Readable,
    metadata: { contentType: string },
  ): PromiseLike<void>;
  openRead(objectKey: string): PromiseLike<Readable>;
}

export class DeletionLogStore {
  constructor(
    private readonly dependencies: {
      storage: DeletionLogStorage;
    },
  ) {}

  private key(deletionRequestId: string): string {
    // The request id IS the object identity: retries overwrite the same
    // object, so a replayed job never forks the log.
    return `${DELETION_LOG_PREFIX}/${deletionRequestId}.json`;
  }

  /**
   * Persists the intent and verifies it reads back intact. A write that
   * cannot be confirmed is a failure: the caller must not proceed to the
   * irreversible step.
   */
  async appendAndConfirm(
    intent: DeletionLogIntent,
  ): Promise<{ confirmed: true } | { confirmed: false; reason: string }> {
    const body = JSON.stringify(intent);
    try {
      await this.dependencies.storage.write(
        this.key(intent.deletionRequestId),
        Readable.from([body]),
        { contentType: "application/json" },
      );
      const readBack = await this.read(intent.deletionRequestId);
      if (!readBack) {
        return { confirmed: false, reason: "DELETION_LOG_UNREADABLE" };
      }
      for (const field of [
        "kind",
        "deletionRequestId",
        "userId",
        "sessionId",
        "arkSessionId",
        "scope",
      ] as const) {
        if (readBack[field] !== intent[field]) {
          return { confirmed: false, reason: "DELETION_LOG_MISMATCH" };
        }
      }
      return { confirmed: true };
    } catch {
      return { confirmed: false, reason: "DELETION_LOG_UNAVAILABLE" };
    }
  }

  async read(
    deletionRequestId: string,
  ): Promise<DeletionLogIntent | undefined> {
    try {
      const stream = await this.dependencies.storage.openRead(
        this.key(deletionRequestId),
      );
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk as Buffer));
        if (chunks.reduce((total, c) => total + c.length, 0) > 16_384) {
          return undefined;
        }
      }
      const parsed = JSON.parse(
        Buffer.concat(chunks).toString("utf8"),
      ) as DeletionLogIntent;
      if (parsed.deletionRequestId !== deletionRequestId) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }
}

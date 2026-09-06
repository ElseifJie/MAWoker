import type { ArkGateway } from "@pwa/ark-client";

export interface SessionInputRecord {
  id: string;
  ownerUserId: string;
  sessionId: string | null;
  arkFileId: string | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  mountPath: string;
  status: "uploading" | "uploaded" | "bound" | "failed" | "deleting";
  expiresAt: Date;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionInputRepository {
  prepareUpload(record: SessionInputRecord): PromiseLike<void>;
  completeUpload(
    id: string,
    userId: string,
    upstream: {
      arkFileId: string;
      mimeType: string;
      sizeBytes: number;
    },
  ): PromiseLike<SessionInputRecord>;
  preserveUploadOutcome(
    id: string,
    userId: string,
    upstream: {
      arkFileId: string;
      mimeType: string;
      sizeBytes: number;
    },
  ): PromiseLike<void>;
  failUpload(id: string, userId: string, errorCode: string): PromiseLike<void>;
  findOwned(
    userId: string,
    id: string,
  ): PromiseLike<SessionInputRecord | undefined>;
  findExpiredUnbound(
    userId: string,
    id: string,
  ): PromiseLike<SessionInputRecord | undefined>;
  removeUnbound(id: string, userId: string): PromiseLike<boolean>;
}

interface InputContext {
  userId: string;
  requestId: string;
}

export class InvalidUploadNameError extends Error {
  readonly code = "INVALID_UPLOAD_NAME";

  constructor() {
    super("Invalid upload filename");
    this.name = "InvalidUploadNameError";
  }
}

function sanitizeFilename(name: string): string {
  const trimmed = name.trim().normalize("NFKC");
  if (
    !trimmed ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0")
  ) {
    throw new InvalidUploadNameError();
  }
  const withoutControls = Array.from(trimmed, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? "_" : character;
  }).join("");
  const sanitized = withoutControls
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 180);
  if (!sanitized || sanitized === "." || sanitized === "..") {
    throw new InvalidUploadNameError();
  }
  return sanitized;
}

function arkErrorCode(error: unknown): string {
  const category =
    typeof error === "object" &&
    error !== null &&
    "category" in error &&
    typeof error.category === "string"
      ? error.category
      : "unavailable";
  return `ARK_${category.toUpperCase()}`;
}

export class SessionInputService {
  constructor(
    private readonly dependencies: {
      repository: SessionInputRepository;
      ark: Pick<ArkGateway, "uploadFile" | "deleteFile">;
      createId: () => string;
      now?: () => Date;
      ttlMs?: number;
    },
  ) {}

  async upload(
    input: { name: string; contentType: string; bytes: Uint8Array },
    context: InputContext,
  ): Promise<SessionInputRecord> {
    const name = sanitizeFilename(input.name);
    const id = this.dependencies.createId();
    const timestamp = (this.dependencies.now ?? (() => new Date()))();
    const record: SessionInputRecord = {
      id,
      ownerUserId: context.userId,
      sessionId: null,
      arkFileId: null,
      originalName: name,
      mimeType: input.contentType,
      sizeBytes: input.bytes.byteLength,
      mountPath: `/mnt/session/inputs/${id}-${name}`,
      status: "uploading",
      expiresAt: new Date(
        timestamp.getTime() + (this.dependencies.ttlMs ?? 24 * 60 * 60_000),
      ),
      lastErrorCode: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.dependencies.repository.prepareUpload(record);

    let uploaded;
    try {
      uploaded = await this.dependencies.ark.uploadFile(
        {
          name,
          contentType: input.contentType,
          bytes: input.bytes,
          purpose: "agent",
        },
        { correlationId: `upload:${id}` },
      );
    } catch (error) {
      await this.dependencies.repository.failUpload(
        id,
        context.userId,
        arkErrorCode(error),
      );
      throw error;
    }

    const outcome = {
      arkFileId: uploaded.id,
      mimeType: uploaded.contentType,
      sizeBytes: uploaded.size,
    };
    try {
      return await this.dependencies.repository.completeUpload(
        id,
        context.userId,
        outcome,
      );
    } catch (error) {
      await this.dependencies.repository.preserveUploadOutcome(
        id,
        context.userId,
        outcome,
      );
      throw error;
    }
  }

  async cleanupExpired(id: string, context: InputContext): Promise<void> {
    const input = await this.dependencies.repository.findExpiredUnbound(
      context.userId,
      id,
    );
    if (!input) return;
    if (input.arkFileId) {
      try {
        await this.dependencies.ark.deleteFile(input.arkFileId, {
          correlationId: context.requestId,
        });
      } catch (error) {
        if (!(
          typeof error === "object" &&
          error !== null &&
          "category" in error &&
          error.category === "not_found"
        )) {
          throw error;
        }
      }
    }
    const removed = await this.dependencies.repository.removeUnbound(
      id,
      context.userId,
    );
    if (!removed) {
      throw new Error("Expired upload was not removed");
    }
  }
}

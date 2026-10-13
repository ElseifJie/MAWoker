import type { Readable } from "node:stream";
import type { ArkGateway } from "@pwa/ark-client";
import { UPLOAD_MAX_BYTES } from "@pwa/contracts";
import { ResourceNotFoundError } from "./errors.js";
import {
  sanitizeFilename,
  UploadTooLargeError,
  type SessionInputRepository,
} from "./session-inputs.js";

export class FileReuseService {
  constructor(
    private readonly dependencies: {
      repository: {
        reserve(input: {
          id: string;
          userId: string;
          artifactId: string;
          expiresAt: Date;
        }): PromiseLike<
          | {
              driveId: string;
              objectKey: string;
              name: string;
              mimeType: string;
              sizeBytes: number;
            }
          | undefined
        >;
        setMount(id: string, userId: string, path: string): PromiseLike<void>;
        release(id: string, userId: string): PromiseLike<void>;
      };
      inputs: Pick<
        SessionInputRepository,
        "completeUpload" | "preserveUploadOutcome"
      >;
      ark: Pick<ArkGateway, "uploadFile">;
      storage: {
        openRead(key: string, signal?: AbortSignal): PromiseLike<Readable>;
      };
      createId: () => string;
      admissionEnabled?: boolean;
    },
  ) {}
  async prepare(
    artifactId: string,
    context: { userId: string; requestId: string; signal?: AbortSignal },
  ) {
    if (this.dependencies.admissionEnabled === false)
      throw Object.assign(
        new Error("Existing-file reuse is temporarily paused; retry later"),
        { code: "FILE_REUSE_ADMISSION_PAUSED" },
      );
    const id = this.dependencies.createId();
    const file = await this.dependencies.repository.reserve({
      id,
      userId: context.userId,
      artifactId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    });
    if (!file) throw new ResourceNotFoundError();
    try {
      context.signal?.throwIfAborted();
      if (file.sizeBytes > UPLOAD_MAX_BYTES) throw new UploadTooLargeError();
      const name = sanitizeFilename(file.name);
      await this.dependencies.repository.setMount(
        id,
        context.userId,
        `/mnt/session/inputs/${id}-${name}`,
      );
      const stream = await this.dependencies.storage.openRead(
        file.objectKey,
        context.signal,
      );
      const buffers: Buffer[] = [];
      let size = 0;
      for await (const part of stream) {
        context.signal?.throwIfAborted();
        const buffer = Buffer.from(part);
        size += buffer.length;
        if (size > UPLOAD_MAX_BYTES) {
          stream.destroy();
          throw new UploadTooLargeError();
        }
        buffers.push(buffer);
      }
      const uploaded = await this.dependencies.ark.uploadFile(
        {
          name,
          bytes: Buffer.concat(buffers),
          contentType: file.mimeType,
          purpose: "agent",
        },
        {
          correlationId: `reuse:${id}`,
          ...(context.signal ? { signal: context.signal } : {}),
        },
      );
      const outcome = {
        arkFileId: uploaded.id,
        mimeType: uploaded.contentType,
        sizeBytes: uploaded.size,
      };
      try {
        return await this.dependencies.inputs.completeUpload(
          id,
          context.userId,
          outcome,
        );
      } catch (error) {
        await this.dependencies.inputs.preserveUploadOutcome(
          id,
          context.userId,
          outcome,
        );
        throw error;
      }
    } catch (error) {
      await this.dependencies.repository.release(id, context.userId);
      throw error;
    }
  }
}

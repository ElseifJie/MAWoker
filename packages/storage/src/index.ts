import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { PassThrough, Readable } from "node:stream";

export interface ArtifactStorage {
  write(
    objectKey: string,
    stream: Readable,
    metadata: { contentType: string; contentLength?: number },
    signal?: AbortSignal,
  ): PromiseLike<void>;
  openRead(objectKey: string, signal?: AbortSignal): PromiseLike<Readable>;
  /**
   * Reads an object this deployment did not write — an Ark export parked in TOS
   * under Ark's own prefix. Separate from `openRead` because the bucket is not
   * ours to assume.
   */
  readExternal(
    input: { bucket: string; objectKey: string },
    signal?: AbortSignal,
  ): PromiseLike<Readable>;
  delete(objectKey: string): PromiseLike<void>;
}

export interface TosObjectClient {
  putObject(
    input: {
      bucket: string;
      key: string;
      body: Readable;
      contentType: string;
      contentLength?: number;
    },
    options?: { signal?: AbortSignal },
  ): PromiseLike<unknown>;
  getObject(
    input: { bucket: string; key: string },
    options?: { signal?: AbortSignal },
  ): PromiseLike<{ body: Readable }>;
  deleteObject(input: { bucket: string; key: string }): PromiseLike<unknown>;
}

export interface TosStorageConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  accessKeySecret: string;
  stsToken?: string;
}

export class StorageProviderError extends Error {
  readonly code = "STORAGE_UNAVAILABLE";

  constructor(readonly operation: "write" | "read" | "delete") {
    super("Artifact storage is unavailable");
    this.name = "StorageProviderError";
  }
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (("statusCode" in error && error.statusCode === 404) ||
      ("status" in error && error.status === 404) ||
      ("code" in error && error.code === "NoSuchKey") ||
      ("name" in error && error.name === "NoSuchKey"))
  );
}

export class TosArtifactStorage implements ArtifactStorage {
  constructor(
    private readonly dependencies: {
      client: TosObjectClient;
      bucket: string;
    },
  ) {}

  async write(
    objectKey: string,
    stream: Readable,
    metadata: { contentType: string; contentLength?: number },
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) {
      stream.destroy();
      throw abortError();
    }
    const abort = () => stream.destroy();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.dependencies.client.putObject(
        {
          bucket: this.dependencies.bucket,
          key: objectKey,
          body: stream,
          contentType: metadata.contentType,
          ...(metadata.contentLength === undefined
            ? {}
            : { contentLength: metadata.contentLength }),
        },
        { ...(signal ? { signal } : {}) },
      );
    } catch (error) {
      stream.destroy();
      if (isAbort(error, signal)) throw abortError();
      throw new StorageProviderError("write");
    } finally {
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) stream.destroy();
    }
  }

  async openRead(objectKey: string, signal?: AbortSignal): Promise<Readable> {
    return this.read(this.dependencies.bucket, objectKey, signal);
  }

  async readExternal(
    input: { bucket: string; objectKey: string },
    signal?: AbortSignal,
  ): Promise<Readable> {
    return this.read(input.bucket, input.objectKey, signal);
  }

  private async read(
    bucket: string,
    objectKey: string,
    signal?: AbortSignal,
  ): Promise<Readable> {
    let result: { body: Readable };
    try {
      result = await this.dependencies.client.getObject(
        { bucket, key: objectKey },
        {
          ...(signal ? { signal } : {}),
        },
      );
    } catch (error) {
      if (isAbort(error, signal)) throw abortError();
      throw new StorageProviderError("read");
    }
    if (signal?.aborted) {
      result.body.destroy();
      throw abortError();
    }
    const stream = new PassThrough();
    const abort = () => {
      result.body.destroy();
      stream.destroy();
    };
    const sourceError = (error: unknown) => {
      stream.destroy(
        isAbort(error, signal)
          ? abortError()
          : new StorageProviderError("read"),
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
    result.body.once("error", sourceError);
    result.body.pipe(stream);
    stream.once("close", () => {
      signal?.removeEventListener("abort", abort);
      result.body.removeListener("error", sourceError);
      if (!result.body.destroyed) result.body.destroy();
    });
    return stream;
  }

  async delete(objectKey: string): Promise<void> {
    try {
      await this.dependencies.client.deleteObject({
        bucket: this.dependencies.bucket,
        key: objectKey,
      });
    } catch (error) {
      if (!isNotFound(error)) throw new StorageProviderError("delete");
    }
  }
}

function externalKey(input: { bucket: string; objectKey: string }): string {
  return `${input.bucket}/${input.objectKey}`;
}

export class InMemoryArtifactStorage implements ArtifactStorage {
  private readonly objects = new Map<
    string,
    { bytes: Uint8Array; contentType: string }
  >();
  /**
   * Source objects live in a separate map so `keys()` keeps meaning "what this
   * deployment wrote", which is what cleanup assertions care about.
   */
  private readonly external = new Map<
    string,
    { bytes: Uint8Array; contentType: string }
  >();

  async write(
    objectKey: string,
    stream: Readable,
    metadata: { contentType: string; contentLength?: number },
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) {
      stream.destroy();
      throw abortError();
    }
    const chunks: Buffer[] = [];
    const abort = () => stream.destroy(abortError());
    signal?.addEventListener("abort", abort, { once: true });
    try {
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    } catch (error) {
      if (isAbort(error, signal)) throw abortError();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
    this.objects.set(objectKey, {
      bytes: new Uint8Array(Buffer.concat(chunks)),
      contentType: metadata.contentType,
    });
  }

  async openRead(objectKey: string, signal?: AbortSignal): Promise<Readable> {
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }
    const object = this.objects.get(objectKey);
    if (!object) {
      throw new StorageProviderError("read");
    }
    const stream = Readable.from([new Uint8Array(object.bytes)]);
    const abort = () => stream.destroy();
    signal?.addEventListener("abort", abort, { once: true });
    stream.once("close", () => signal?.removeEventListener("abort", abort));
    return stream;
  }

  async readExternal(
    input: { bucket: string; objectKey: string },
    signal?: AbortSignal,
  ): Promise<Readable> {
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }
    const object = this.external.get(externalKey(input));
    if (!object) {
      throw new StorageProviderError("read");
    }
    const stream = Readable.from([new Uint8Array(object.bytes)]);
    const abort = () => stream.destroy();
    signal?.addEventListener("abort", abort, { once: true });
    stream.once("close", () => signal?.removeEventListener("abort", abort));
    return stream;
  }

  /** Primes a source object as if Ark had parked it in TOS. */
  putExternal(
    input: { bucket: string; objectKey: string },
    bytes: Uint8Array,
    contentType: string,
  ): void {
    this.external.set(externalKey(input), { bytes, contentType });
  }

  async delete(objectKey: string): Promise<void> {
    this.objects.delete(objectKey);
  }

  keys(): string[] {
    return [...this.objects.keys()];
  }
}

type TosClientFactory = (options: {
  endpoint: string;
  region: string;
  accessKeyId: string;
  accessKeySecret: string;
  stsToken?: string;
}) => TosObjectClient;

function defaultClientFactory(
  options: Parameters<TosClientFactory>[0],
): TosObjectClient {
  const client = new S3Client({
    endpoint: options.endpoint,
    region: options.region,
    forcePathStyle: false,
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.accessKeySecret,
      ...(options.stsToken ? { sessionToken: options.stsToken } : {}),
    },
  });
  return {
    async putObject(input, requestOptions) {
      await client.send(
        new PutObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
          ...(input.contentLength === undefined
            ? {}
            : { ContentLength: input.contentLength }),
        }),
        requestOptions?.signal
          ? { abortSignal: requestOptions.signal }
          : undefined,
      );
    },
    async getObject(input, requestOptions) {
      const result = await client.send(
        new GetObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
        }),
        requestOptions?.signal
          ? { abortSignal: requestOptions.signal }
          : undefined,
      );
      if (!(result.Body instanceof Readable)) {
        throw new Error("TOS returned a non-streaming object body");
      }
      return { body: result.Body };
    },
    async deleteObject(input) {
      await client.send(
        new DeleteObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
        }),
      );
    },
  };
}

export function createTosArtifactStorage(
  config: TosStorageConfig,
  createClient: TosClientFactory = defaultClientFactory,
): TosArtifactStorage {
  const client = createClient({
    endpoint: config.endpoint,
    region: config.region,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    ...(config.stsToken ? { stsToken: config.stsToken } : {}),
  });
  return new TosArtifactStorage({ client, bucket: config.bucket });
}

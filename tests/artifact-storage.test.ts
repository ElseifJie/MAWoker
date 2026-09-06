import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createTosArtifactStorage,
  InMemoryArtifactStorage,
  TosArtifactStorage,
} from "../packages/storage/src/index.js";

describe("artifact storage adapters", () => {
  async function collect(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return new Uint8Array(Buffer.concat(chunks));
  }

  it("keeps the in-memory stub private and deletion idempotent", async () => {
    const storage = new InMemoryArtifactStorage();
    const bytes = new Uint8Array([1, 2, 3]);

    await storage.write(
      "private/key",
      Readable.from([bytes]),
      {
        contentType: "application/octet-stream",
        contentLength: bytes.byteLength,
      },
      undefined,
    );
    await expect(
      storage.openRead("private/key").then(collect),
    ).resolves.toEqual(bytes);
    await storage.delete("private/key");
    await storage.delete("private/key");
    await expect(storage.openRead("private/key")).rejects.toMatchObject({
      name: "StorageProviderError",
      code: "STORAGE_UNAVAILABLE",
    });
  });

  it("delegates object operations and preserves the TOS download stream", async () => {
    const body = Readable.from([Buffer.from([4]), Buffer.from([5])]);
    const client = {
      putObject: vi.fn(async () => undefined),
      getObject: vi.fn(async () => ({ body })),
      deleteObject: vi.fn(async () => undefined),
    };
    const storage = new TosArtifactStorage({
      client,
      bucket: "private-bucket",
    });

    const upload = Readable.from([new Uint8Array([4, 5])]);
    const controller = new AbortController();
    await storage.write(
      "tenant/session/object",
      upload,
      {
        contentType: "text/plain",
        contentLength: 2,
      },
      controller.signal,
    );
    const stream = await storage.openRead("tenant/session/object");
    await expect(collect(stream)).resolves.toEqual(new Uint8Array([4, 5]));
    await storage.delete("tenant/session/object");

    expect(client.putObject).toHaveBeenCalledWith(
      {
        bucket: "private-bucket",
        key: "tenant/session/object",
        body: upload,
        contentType: "text/plain",
        contentLength: 2,
      },
      {
        signal: controller.signal,
      },
    );
    expect(client.getObject).toHaveBeenCalledWith(
      {
        bucket: "private-bucket",
        key: "tenant/session/object",
      },
      {},
    );
    expect(client.deleteObject).toHaveBeenCalledWith({
      bucket: "private-bucket",
      key: "tenant/session/object",
    });
  });

  it("creates the production client from validated TOS configuration", () => {
    const client = {
      putObject: vi.fn(async () => undefined),
      getObject: vi.fn(async () => ({ body: Readable.from([]) })),
      deleteObject: vi.fn(async () => undefined),
    };
    const createClient = vi.fn(() => client);

    expect(
      createTosArtifactStorage(
        {
          endpoint: "https://tos.example.com",
          bucket: "private-bucket",
          region: "cn-beijing",
          accessKeyId: "access-key",
          accessKeySecret: "secret-key",
          stsToken: "session-token",
        },
        createClient,
      ),
    ).toBeInstanceOf(TosArtifactStorage);
    expect(createClient).toHaveBeenCalledWith({
      endpoint: "https://tos.example.com",
      region: "cn-beijing",
      accessKeyId: "access-key",
      accessKeySecret: "secret-key",
      stsToken: "session-token",
    });
  });

  it("destroys an open TOS stream when its request is cancelled", async () => {
    const body = new Readable({ read() {} });
    const client = {
      putObject: vi.fn(async () => undefined),
      getObject: vi.fn(async () => ({ body })),
      deleteObject: vi.fn(async () => undefined),
    };
    const storage = new TosArtifactStorage({
      client,
      bucket: "private-bucket",
    });
    const controller = new AbortController();

    await storage.openRead("tenant/session/object", controller.signal);
    controller.abort();

    expect(body.destroyed).toBe(true);
    expect(client.getObject).toHaveBeenCalledWith(
      {
        bucket: "private-bucket",
        key: "tenant/session/object",
      },
      { signal: controller.signal },
    );
  });

  it("passes cancellation to an upload and destroys its source stream", async () => {
    const body = new Readable({ read() {} });
    const client = {
      putObject: vi.fn(
        async (
          _input: unknown,
          options?: { signal?: AbortSignal },
        ): Promise<void> => {
          await new Promise<void>((_resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          });
        },
      ),
      getObject: vi.fn(async () => ({ body: Readable.from([]) })),
      deleteObject: vi.fn(async () => undefined),
    };
    const storage = new TosArtifactStorage({
      client,
      bucket: "private-bucket",
    });
    const controller = new AbortController();

    const write = storage.write(
      "private/secret/object",
      body,
      { contentType: "application/octet-stream", contentLength: 1024 },
      controller.signal,
    );
    controller.abort();

    await expect(write).rejects.toMatchObject({ name: "AbortError" });
    expect(body.destroyed).toBe(true);
    expect(client.putObject).toHaveBeenCalledWith(
      expect.objectContaining({
        body,
        contentLength: 1024,
      }),
      { signal: controller.signal },
    );
  });

  it("maps provider failures without retaining object keys or messages", async () => {
    const client = {
      putObject: vi.fn(async () => {
        throw new Error("provider denied private/tenant/secret.txt");
      }),
      getObject: vi.fn(async () => {
        throw new Error("provider leaked private/tenant/secret.txt");
      }),
      deleteObject: vi.fn(async () => {
        throw new Error("provider leaked private/tenant/secret.txt");
      }),
    };
    const storage = new TosArtifactStorage({
      client,
      bucket: "private-bucket",
    });

    const operations = [
      () =>
        storage.write(
          "private/tenant/secret.txt",
          Readable.from([]),
          { contentType: "text/plain" },
          undefined,
        ),
      () => storage.openRead("private/tenant/secret.txt"),
      () => storage.delete("private/tenant/secret.txt"),
    ];
    for (const operation of operations) {
      const result = operation();
      await expect(result).rejects.toMatchObject({
        name: "StorageProviderError",
        code: "STORAGE_UNAVAILABLE",
      });
      await expect(operation()).rejects.not.toThrow(
        /private\/tenant|provider leaked|provider denied/,
      );
    }
  });

  it("sanitizes provider errors emitted after a download stream opens", async () => {
    const body = new Readable({ read() {} });
    const client = {
      putObject: vi.fn(async () => undefined),
      getObject: vi.fn(async () => ({ body })),
      deleteObject: vi.fn(async () => undefined),
    };
    const storage = new TosArtifactStorage({
      client,
      bucket: "private-bucket",
    });
    const stream = await storage.openRead("private/tenant/secret.txt");
    const collected = collect(stream);

    body.destroy(new Error("provider stream leaked private/tenant/secret.txt"));

    await expect(collected).rejects.toMatchObject({
      name: "StorageProviderError",
      code: "STORAGE_UNAVAILABLE",
      operation: "read",
    });
    await expect(collected).rejects.not.toThrow(
      /private\/tenant|provider stream leaked/,
    );
  });
});

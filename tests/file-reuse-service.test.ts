import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { FileReuseService } from "../packages/domain/src/file-reuse.js";
describe("reuse material preparation", () => {
  it("rejects new reuse before reserving or reading when admission is paused", async () => {
    const reserve = vi.fn(),
      read = vi.fn();
    const service = new FileReuseService({
      repository: { reserve, setMount: vi.fn(), release: vi.fn() },
      inputs: {} as never,
      ark: {} as never,
      storage: { openRead: read },
      createId: () => "new",
      admissionEnabled: false,
    } as ConstructorParameters<typeof FileReuseService>[0]);
    await expect(
      service.prepare("artifact", { userId: "owner", requestId: "pause" }),
    ).rejects.toMatchObject({ code: "FILE_REUSE_ADMISSION_PAUSED" });
    expect(reserve).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
  it("reserves before reading private bytes and keeps a separate owned upload", async () => {
    const order: string[] = [];
    const repository = {
      reserve: vi.fn(async () => {
        order.push("reserve");
        return {
          driveId: "drive",
          objectKey: "key",
          name: "报告.txt",
          mimeType: "text/plain",
          sizeBytes: 3,
        };
      }),
      setMount: vi.fn(),
      release: vi.fn(),
    };
    const inputs = {
      completeUpload: vi.fn(async () => ({
        id: "new-input",
        originalName: "报告.txt",
      })),
    };
    const ark = {
      uploadFile: vi.fn(async () => ({
        id: "new-ark",
        contentType: "text/plain",
        size: 3,
      })),
    };
    const service = new FileReuseService({
      repository,
      inputs: inputs as never,
      ark: ark as never,
      storage: {
        openRead: async () => {
          order.push("read");
          return Readable.from([Buffer.from("abc")]);
        },
      },
      createId: () => "new-input",
    });
    expect(
      await service.prepare("artifact", { userId: "owner", requestId: "test" }),
    ).toMatchObject({ id: "new-input" });
    expect(order).toEqual(["reserve", "read"]);
    expect(ark.uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ name: "__.txt", purpose: "agent" }),
      expect.anything(),
    );
  });
});

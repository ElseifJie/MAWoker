import { describe, expect, it, vi } from "vitest";
import {
  MaterialUploadQueue,
  validateMaterials,
} from "../apps/web/src/material-upload-queue.js";
describe("material uploads", () => {
  it("rejects count, individual and total size before accepting a batch", () => {
    expect(
      validateMaterials(
        Array.from({ length: 21 }, () => ({ size: 1 })),
        [],
      ),
    ).toContain("20");
    expect(validateMaterials([{ size: 20 * 1024 * 1024 + 1 }], [])).toContain(
      "20 MB",
    );
    expect(
      validateMaterials(
        Array.from({ length: 6 }, () => ({ size: 20 * 1024 * 1024 })),
        [],
      ),
    ).toContain("100 MB");
  });
  it("limits concurrent tasks and cancellation prevents queued work", async () => {
    const queue = new MaterialUploadQueue(2);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const work = vi.fn(async () => held);
    const first = queue.add(1, work),
      second = queue.add(2, work),
      third = queue.add(3, work);
    void third.catch(() => {});
    await Promise.resolve();
    expect(work).toHaveBeenCalledTimes(2);
    queue.cancel(3);
    release();
    await Promise.all([first, second]);
    await expect(third).rejects.toThrow();
    expect(work).toHaveBeenCalledTimes(2);
  });
});

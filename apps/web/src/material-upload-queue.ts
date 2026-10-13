import {
  TASK_MAX_INPUTS,
  TASK_MAX_INPUT_BYTES,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_CONCURRENCY,
} from "@pwa/contracts";

export function validateMaterials(
  files: readonly { size: number }[],
  existing: readonly { size: number }[],
) {
  if (files.length + existing.length > TASK_MAX_INPUTS)
    return "每个任务最多添加 20 个材料。";
  if (files.some((file) => file.size > UPLOAD_MAX_BYTES))
    return "单个材料不能超过 20 MB。";
  if (
    [...files, ...existing].reduce((sum, file) => sum + file.size, 0) >
    TASK_MAX_INPUT_BYTES
  )
    return "每个任务的材料总量不能超过 100 MB。";
  return null;
}
export class MaterialUploadQueue {
  private active = 0;
  private pending: Array<{
    key: number;
    controller: AbortController;
    run: () => void;
    reject: (reason: unknown) => void;
  }> = [];
  private controllers = new Map<number, AbortController>();
  constructor(private readonly limit = UPLOAD_MAX_CONCURRENCY) {}
  add<T>(key: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.controllers.set(key, controller);
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        key,
        controller,
        reject,
        run: () => {
          this.active++;
          Promise.resolve()
            .then(() => {
              controller.signal.throwIfAborted();
              return work(controller.signal);
            })
            .then(resolve, reject)
            .finally(() => {
              this.active--;
              this.controllers.delete(key);
              this.drain();
            });
        },
      });
      this.drain();
    });
  }
  cancel(key: number) {
    this.controllers.get(key)?.abort();
    const item = this.pending.find((item) => item.key === key);
    if (item) {
      this.pending = this.pending.filter((candidate) => candidate !== item);
      item.reject(new DOMException("上传已取消", "AbortError"));
      this.controllers.delete(key);
    }
  }
  dispose() {
    for (const key of this.controllers.keys()) this.cancel(key);
  }
  private drain() {
    while (this.active < this.limit && this.pending.length)
      this.pending.shift()!.run();
  }
}

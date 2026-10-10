import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("runs the offline memory demo against migrated PGlite", async () => {
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "scripts/memory-demo.ts"],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      timeout: 180_000,
      maxBuffer: 1024 * 1024,
    },
  );
  expect(stderr).toContain("全部断言通过");
  expect(stderr).not.toContain("记忆演示失败");
  const report = JSON.parse(stdout);
  expect(report.结果).toBe("通过");
  expect(report.隔离.同一用户跨会话复用).toBe(true);
  expect(report.隔离.不同用户不同库).toBe(true);
  expect(report.隔离.数据库绑定一致).toBe(true);
  expect(report.偏好.写入阶段).toEqual([
    "queued",
    "apply",
    "cleanup",
    "completed",
  ]);
  expect(report.Dream.阶段).toEqual([
    "queued",
    "snapshot",
    "submit",
    "polling",
    "merge",
    "apply",
    "cleanup",
    "completed",
  ]);
  expect(report.Dream.纠正保留).toBe(true);
  expect(report.Dream.轮询等待已验证).toBe(true);
  expect(report.Dream.临时库已清理).toBe(true);
  expect(report.压缩.自动排队).toBe(true);
  expect(report.压缩.之前.count).toBeGreaterThanOrEqual(1600);
  expect(report.压缩.之前.level).toBe("high");
  expect(report.压缩.之后.count).toBeLessThan(report.压缩.之前.count);
  expect(report.压缩.部分压缩).toBe(true);
  expect(report.压缩.之后.count).toBeGreaterThan(report.压缩.之后.targetCount);
  expect(report.压缩.原文路径全部保留).toBe(true);
  expect(report.压缩.保护条目保持原样).toBe(true);
  expect(report.压缩.先更新存留条目再删除).toBe(true);
  expect(report.压缩.未创建Dream).toBe(true);
  expect(report.压缩.ticks).toBeLessThanOrEqual(30);
}, 180_000);

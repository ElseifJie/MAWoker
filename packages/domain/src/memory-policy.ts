import { createHash } from "node:crypto";
import { detectSensitiveAssignments } from "@pwa/contracts";

export interface MemoryText {
  id: string;
  path: string;
  content: string;
}
export interface MemoryStep {
  kind: "put" | "delete";
  path: string;
  content?: string;
  before: string | null;
  status: "planned" | "sending" | "verified";
  memoryId?: string;
}
export class MemoryError extends Error {
  constructor(
    public readonly code:
      | "MEMORY_BUSY"
      | "MEMORY_CONFLICT"
      | "MEMORY_INVALID"
      | "MEMORY_CAPACITY"
      | "MEMORY_REPAIR_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "MemoryError";
  }
}
export const hashMemory = (content: string) =>
  createHash("sha256").update(content).digest("hex");

/**
 * Deterministic JSON serialization for fingerprinting upstream payloads.
 * Object keys are sorted recursively, so semantically identical payloads hash
 * identically no matter how the serializer ordered them — the upstream events
 * API re-serializes tool-call input maps on every request, so a raw
 * JSON.stringify fingerprint changed per fetch and drove consolidation into
 * an endless dream/conflict cycle.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
export function validateMemory(path: string, content: string) {
  if (
    !/\.(md|txt)$/.test(path) ||
    /[%;?]/.test(path) ||
    [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    Buffer.byteLength(path, "utf8") > 1024 ||
    Buffer.from(path, "utf8").toString("utf8") !== path ||
    Buffer.from(content, "utf8").toString("utf8") !== content
  )
    throw new MemoryError("MEMORY_INVALID", "记忆路径或正文编码不符合接口规范");
  if (!/^\/(?:memories|procedures|episodes|resources)\/[^\\\0]+$/.test(path))
    throw new MemoryError("MEMORY_INVALID", "记忆路径不在个人目录内");
  if (
    path
      .split("/")
      .some((part) => part === "." || part === ".." || part === "") &&
    !path.startsWith("/")
  )
    throw new MemoryError("MEMORY_INVALID", "记忆路径无效");
  if (
    path
      .slice(1)
      .split("/")
      .some((part) => part === "." || part === ".." || !part) ||
    path.length > 512
  )
    throw new MemoryError("MEMORY_INVALID", "记忆路径无效");
  if (Buffer.byteLength(content, "utf8") > 102400)
    throw new MemoryError("MEMORY_CAPACITY", "单条记忆不能超过 100 KiB");
  if (
    detectSensitiveAssignments(content).length > 0 ||
    /[?&](?:X-Tos-Signature|X-Amz-Signature)=/i.test(content)
  )
    throw new MemoryError(
      "MEMORY_INVALID",
      "凭证和临时签名链接不能保存为长期记忆",
    );
}
export function capacity(entries: MemoryText[], budget?: number) {
  const sizes = entries.map((e) => Buffer.byteLength(e.content, "utf8"));
  const bytes = sizes.reduce((sum, n) => sum + n, 0);
  const maxEntryBytes = Math.max(0, ...sizes);
  const countRatio = entries.length / 2000;
  const byteRatio = budget ? bytes / budget : null;
  const ratio = Math.max(countRatio, maxEntryBytes / 102400, byteRatio ?? 0);
  const level =
    ratio >= 1
      ? "full"
      : ratio >= 0.9
        ? "critical"
        : ratio >= 0.8
          ? "high"
          : ratio >= 0.7
            ? "watch"
            : "normal";
  return {
    count: entries.length,
    bytes,
    maxEntryBytes,
    countRatio,
    byteRatio,
    level,
    targetCount: 1200,
  } as const;
}
export function mergePlan(
  base: MemoryText[],
  candidate: MemoryText[],
  live: MemoryText[],
  protectedPaths: string[],
  revoked: string[],
): MemoryStep[] {
  const b = new Map(base.map((e) => [e.path, e]));
  const l = new Map(live.map((e) => [e.path, e]));
  const seen = new Set<string>();
  const steps: MemoryStep[] = [];
  let count = live.length;
  for (const e of candidate) {
    validateMemory(e.path, e.content);
    if (seen.has(e.path))
      throw new MemoryError("MEMORY_INVALID", "候选有重复路径");
    seen.add(e.path);
    if (revoked.includes(e.path) || protectedPaths.includes(e.path)) continue;
    const old = b.get(e.path);
    const latest = l.get(e.path);
    if (old && (!latest || latest.content !== old.content)) continue;
    if (!old && latest) continue;
    if (latest?.content === e.content) continue;
    if (!latest && ++count > 2000)
      throw new MemoryError("MEMORY_CAPACITY", "回写峰值超过 2,000 条");
    steps.push({
      kind: "put",
      path: e.path,
      content: e.content,
      before: latest ? hashMemory(latest.content) : null,
      status: "planned",
      ...(latest ? { memoryId: latest.id } : {}),
    });
  }
  // Navigation (dotfile basenames) is published last. Candidate omission is
  // never a deletion.
  const isNavigation = (path: string) =>
    path.split("/").some((part) => part.startsWith("."));
  return steps.sort(
    (a, b) => Number(isNavigation(a.path)) - Number(isNavigation(b.path)),
  );
}
export function cleanPlan(
  entries: MemoryText[],
  protectedPaths: string[],
): MemoryStep[] {
  const kept = new Set(
    entries
      .filter((e) => protectedPaths.includes(e.path))
      .map((e) => hashMemory(e.content)),
  );
  const steps: MemoryStep[] = [];
  for (const e of entries) {
    if (protectedPaths.includes(e.path)) continue;
    const hash = hashMemory(e.content);
    if (!e.content.trim() || kept.has(hash)) {
      steps.push({
        kind: "delete",
        path: e.path,
        before: hash,
        status: "planned",
        memoryId: e.id,
      });
    } else kept.add(hash);
  }
  return steps;
}

/** Lossless packing: source paths and exact bodies remain in the survivor.
 * Only episodic digest siblings are eligible; semantic facts and handoffs are
 * not mixed. At a full Store this updates an existing entry before freeing any
 * slots.
 */
export function compactPlan(
  entries: MemoryText[],
  protectedPaths: string[],
): MemoryStep[] {
  const clean = cleanPlan(entries, protectedPaths);
  const removed = new Set(clean.map((s) => s.path));
  const groups = new Map<string, MemoryText[]>();
  for (const entry of entries) {
    if (protectedPaths.includes(entry.path) || removed.has(entry.path))
      continue;
    if (!/^\/episodes\/digest\//.test(entry.path)) continue;
    const parent = entry.path.slice(0, entry.path.lastIndexOf("/"));
    const group = groups.get(parent) ?? [];
    group.push(entry);
    groups.set(parent, group);
  }
  const packed: MemoryStep[] = [];
  for (const group of groups.values()) {
    let batch: MemoryText[] = [];
    let body = "";
    const flush = () => {
      if (batch.length < 2) return;
      const survivor = batch[0]!;
      packed.push({
        kind: "put",
        path: survivor.path,
        content: body,
        before: hashMemory(survivor.content),
        status: "planned",
        memoryId: survivor.id,
      });
      for (const source of batch.slice(1))
        packed.push({
          kind: "delete",
          path: source.path,
          before: hashMemory(source.content),
          status: "planned",
          memoryId: source.id,
        });
    };
    for (const entry of group) {
      const block = `\n## 来源路径 ${entry.path}\n${entry.content}\n`;
      if (Buffer.byteLength(body + block, "utf8") > 61440) {
        flush();
        batch = [];
        body = "";
      }
      if (Buffer.byteLength(block, "utf8") > 61440) continue;
      batch.push(entry);
      body += block;
    }
    flush();
  }
  return [...clean, ...packed];
}

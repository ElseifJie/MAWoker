export function presentMemory(entry: { path: string; content: string }) {
  const category = entry.path.startsWith("/procedures/")
    ? "协作习惯"
    : /\/(?:preferences?|偏好)(?:[/.]|$)/i.test(entry.path)
      ? "偏好"
      : entry.path.startsWith("/memories/")
        ? "事实"
        : entry.path.startsWith("/episodes/")
          ? "经历"
          : "资料";
  const source = /^sourceSessionId:\s*([^\s]+)\s*$/m.exec(entry.content)?.[1];
  return { category, source: source ? `任务 ${source}` : "来源未知" };
}

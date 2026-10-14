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

/** Friendly labels keep generated IDs out of the directory; original names
 * remain the accessible label, tooltip and selected editor path. */
export function memoryFileLabel(path: string): string {
  const name = path.split("/").at(-1) ?? path;
  const session =
    /^sesn-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})\d{2}-[^/]+\.md$/.exec(name);
  if (session)
    return `会话摘要 · ${session[2]}/${session[3]} ${session[4]}:${session[5]}`;
  return name.replace(/\.(md|txt)$/i, "");
}

import type { ToolItem } from "./timeline/items.js";

/**
 * A tool line split so the transcript can emphasise the object: "Read
 * **report.md**". Keeping the object separate also lets a screen reader hear
 * the verb and its target as one phrase while sighted users get the bolding.
 */
export interface HumanizedLine {
  pre: string;
  obj?: string;
  post?: string;
}

type ObjectShape = "path" | "url" | "text" | "none";

interface ToolLine {
  running: string;
  done: string;
  failed: string;
  shape: ObjectShape;
}

/**
 * Verbs for the tools `agent_toolset_20260701` actually exposes, plus
 * `todo_write`, which appears in live traffic despite not being declared in the
 * toolset config. Names were read off captured events, not documentation.
 */
const TOOL_LINES: Record<string, ToolLine> = {
  bash: {
    running: "正在执行",
    done: "已执行命令",
    failed: "命令执行失败",
    shape: "text",
  },
  read: {
    running: "正在读取",
    done: "已读取",
    failed: "读取失败",
    shape: "path",
  },
  write: {
    running: "正在写入",
    done: "已写入",
    failed: "写入失败",
    shape: "path",
  },
  edit: {
    running: "正在编辑",
    done: "已编辑",
    failed: "编辑失败",
    shape: "path",
  },
  glob: {
    running: "正在查找文件",
    done: "已查找文件",
    failed: "文件查找失败",
    shape: "text",
  },
  grep: {
    running: "正在搜索",
    done: "已搜索",
    failed: "搜索失败",
    shape: "text",
  },
  web_fetch: {
    running: "正在获取",
    done: "已获取",
    failed: "获取失败",
    shape: "url",
  },
  web_search: {
    running: "正在搜索网页",
    done: "已搜索网页",
    failed: "网页搜索失败",
    shape: "text",
  },
  todo_write: {
    running: "正在更新任务清单",
    done: "已更新任务清单",
    failed: "任务清单更新失败",
    shape: "none",
  },
};

function basename(value: string): string {
  const segments = value.split("/").filter((segment) => segment.length > 0);
  return segments.at(-1) ?? value;
}

function hostOf(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function shapeObject(shape: ObjectShape, value: string): string {
  if (shape === "path") return basename(value);
  if (shape === "url") return hostOf(value);
  return value;
}

function todoSummary(todos: ToolItem["todos"]): string | undefined {
  if (!todos || todos.length === 0) return undefined;
  const done = todos.filter((todo) => todo.status === "completed").length;
  const active = todos.find((todo) => todo.status === "in_progress");
  if (active) return `已完成 ${done}/${todos.length} · ${active.content}`;
  return `已完成 ${done}/${todos.length}`;
}

/**
 * Renders a tool call as one honest line. The object always comes from the
 * server's redacted argument summary, never from raw arguments, so this cannot
 * widen what the browser is allowed to see.
 */
export function humanizeTool(item: ToolItem): HumanizedLine {
  const name = item.name;
  if (name === undefined) {
    return { pre: item.status === "running" ? "正在处理" : "已处理" };
  }

  const line = TOOL_LINES[name];
  if (!line) {
    // MCP and custom tools have arbitrary names; say so rather than inventing
    // a verb that implies we know what the tool does.
    const verb =
      item.status === "running"
        ? "正在使用"
        : item.status === "failed"
          ? "工具执行失败"
          : "已使用";
    return {
      pre: verb,
      ...(name ? { obj: name } : {}),
      ...(item.argsSummary ? { post: item.argsSummary } : {}),
    };
  }

  const pre =
    item.status === "running"
      ? line.running
      : item.status === "failed"
        ? line.failed
        : line.done;

  if (name === "todo_write") {
    const summary = todoSummary(item.todos);
    return summary === undefined ? { pre } : { pre, obj: summary };
  }

  const summary = item.argsSummary;
  if (summary === undefined) return { pre };

  if (name === "web_search") {
    const queries = summary.split(" · ");
    const [first, ...rest] = queries;
    return {
      pre,
      ...(first ? { obj: first } : {}),
      ...(rest.length > 0 ? { post: `另 ${rest.length} 项` } : {}),
    };
  }

  return { pre, obj: shapeObject(line.shape, summary) };
}

/** The single line a collapsed, in-flight turn shows to say what is happening. */
export function humanizeActivity(
  items: readonly ToolItem[],
): string | undefined {
  const active = items.at(-1);
  if (!active) return undefined;
  const { pre, obj } = humanizeTool(active);
  return obj === undefined ? pre : `${pre} ${obj}`;
}

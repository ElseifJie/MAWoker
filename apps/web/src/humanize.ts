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
    running: "Running",
    done: "Ran a command",
    failed: "A command failed",
    shape: "text",
  },
  read: {
    running: "Reading",
    done: "Read",
    failed: "Could not read",
    shape: "path",
  },
  write: {
    running: "Writing",
    done: "Wrote",
    failed: "Could not write",
    shape: "path",
  },
  edit: {
    running: "Editing",
    done: "Edited",
    failed: "Could not edit",
    shape: "path",
  },
  glob: {
    running: "Looking for files matching",
    done: "Found files matching",
    failed: "File search failed for",
    shape: "text",
  },
  grep: {
    running: "Searching for",
    done: "Searched for",
    failed: "Search failed for",
    shape: "text",
  },
  web_fetch: {
    running: "Fetching",
    done: "Fetched",
    failed: "Could not fetch",
    shape: "url",
  },
  web_search: {
    running: "Searching the web for",
    done: "Searched the web for",
    failed: "Web search failed for",
    shape: "text",
  },
  todo_write: {
    running: "Updating the task list",
    done: "Updated the task list",
    failed: "Could not update the task list",
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
  if (active) return `${done}/${todos.length} done · ${active.content}`;
  return `${done}/${todos.length} done`;
}

/**
 * Renders a tool call as one honest line. The object always comes from the
 * server's redacted argument summary, never from raw arguments, so this cannot
 * widen what the browser is allowed to see.
 */
export function humanizeTool(item: ToolItem): HumanizedLine {
  const name = item.name;
  if (name === undefined) {
    return { pre: item.status === "running" ? "Working" : "Worked" };
  }

  const line = TOOL_LINES[name];
  if (!line) {
    // MCP and custom tools have arbitrary names; say so rather than inventing
    // a verb that implies we know what the tool does.
    const verb =
      item.status === "running"
        ? "Using"
        : item.status === "failed"
          ? "Failed using"
          : "Used";
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
      ...(rest.length > 0 ? { post: `+${rest.length} more` } : {}),
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

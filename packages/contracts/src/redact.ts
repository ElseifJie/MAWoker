/**
 * Redaction and truncation for tool payloads crossing into the browser.
 *
 * Everything here is a pure function so the security guarantees are unit-testable
 * without a server. The rules encode the measured sandbox layout (see
 * tests/fixtures/ark-events-*.json): `/workspace/` is the Agent's own working
 * directory and `/mnt/session/` is its input/output mount, so both are meaningful
 * to the session owner and survive; `/mnt/skills/` exposes platform Skill
 * internals and is always erased.
 */

export const TOOL_PREVIEW_LIMIT = 500;
export const TOOL_ARGS_LIMIT = 60;
export const TODO_CONTENT_LIMIT = 200;
export const TODO_LIMIT = 50;

export type ToolStatus = "ok" | "failed";

export interface TodoEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

const KEEP_PATH_PREFIXES = ["/workspace/", "/mnt/session/"];
const SCRUB_PATH_PREFIXES = ["/mnt/skills/"];

const ABSOLUTE_PATH =
  /\/(?:mnt|workspace|tmp|var|home|root|usr|etc|opt|private|srv|data|app|Users)(?:\/[A-Za-z0-9._+@~-]+)+/g;

const CREDENTIAL_PATTERNS: [RegExp, string][] = [
  // Signed URLs: the signature/expiry live in the query string. No leading word
  // boundary — Ark glues these straight onto the preceding message text.
  [/(https?:\/\/[^\s"'<>]+?)\?[^\s"'<>]*/gi, "$1"],
  // TOS / object-store keys.
  [/\btos-[a-z]+-[a-z0-9-]+\/[A-Za-z0-9_~.-]+/gi, "[redacted-object-key]"],
  [/\b(?:sk|ark|ak)-[A-Za-z0-9_-]{16,}\b/gi, "[redacted-key]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted-key]"],
  [
    /\b(authorization|cookie|set-cookie|x-api-key|api[_-]?key|password|secret|token)\b\s*[:=]\s*(?:bearer|basic)?\s*\S+/gi,
    "$1: [redacted]",
  ],
];

const DENIED_ARG_KEYS = new Set([
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "password",
  "secret",
  "token",
  "apikey",
  "api_key",
  "access_key",
  "session",
  "auth",
]);

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function replacePath(match: string): string {
  if (SCRUB_PATH_PREFIXES.some((prefix) => match.startsWith(prefix))) {
    return "[redacted-path]";
  }
  if (KEEP_PATH_PREFIXES.some((prefix) => match.startsWith(prefix))) {
    return match;
  }
  const segments = match.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? "[redacted-path]";
}

/**
 * Erases credentials, signed-URL query strings and object-store keys.
 *
 * Applied to message bodies as well as tool payloads: Ark injects platform
 * content into `user.message` — a Skill invocation envelope plus a presigned TOS
 * attachment URL whose query string carries an access-key-derived credential and
 * a 30-day expiry (requirement 8.4 forbids exposing long-lived URLs).
 */
export function redactCredentials(text: string): string {
  let out = text;
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** Erases credentials and rewrites sandbox paths to what the owner may see. */
export function redactText(text: string): string {
  return redactCredentials(text).replace(ABSOLUTE_PATH, replacePath);
}

/** Redacts then truncates free-form tool output for display. */
export function redactPreview(content: string): string {
  return truncate(redactText(content), TOOL_PREVIEW_LIMIT);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parts(...values: (string | undefined)[]): string | undefined {
  const kept = values.filter((v): v is string => v !== undefined);
  return kept.length > 0 ? kept.join(" ") : undefined;
}

function searchQueries(input: Record<string, unknown>): string | undefined {
  const list = input.search_request_list;
  if (Array.isArray(list)) {
    const queries = list
      .map((entry) =>
        typeof entry === "object" && entry !== null
          ? str((entry as Record<string, unknown>).query)
          : undefined,
      )
      .filter((q): q is string => q !== undefined);
    if (queries.length > 0) return queries.join(" · ");
  }
  return str(input.query);
}

// Only the tools actually exposed by agent_toolset_20260701, plus todo_write.
const ARG_SUMMARIES: Record<
  string,
  (input: Record<string, unknown>) => string | undefined
> = {
  bash: (input) => str(input.description) ?? str(input.command),
  read: (input) => str(input.file_path),
  write: (input) => str(input.file_path),
  edit: (input) => str(input.file_path),
  glob: (input) => parts(str(input.pattern), str(input.path)),
  grep: (input) => str(input.pattern),
  web_fetch: (input) => str(input.url),
  web_search: searchQueries,
};

function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

// MCP and custom tools have arbitrary schemas: project scalars only, drop
// anything whose key looks credential-shaped, and bound the total length.
function genericSummary(input: Record<string, unknown>): string | undefined {
  const kept: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (DENIED_ARG_KEYS.has(key.toLowerCase().replace(/[-_\s]/g, ""))) continue;
    if (!isScalar(value)) continue;
    kept.push(`${key}=${truncate(String(value), TOOL_ARGS_LIMIT)}`);
    if (kept.join(", ").length >= TOOL_ARGS_LIMIT * 2) break;
  }
  return kept.length > 0 ? kept.join(", ") : undefined;
}

/** One redacted, bounded line describing a tool call's arguments. */
export function summarizeToolArgs(
  name: string | undefined,
  input: unknown,
): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const summarizer = name === undefined ? undefined : ARG_SUMMARIES[name];
  const summary = summarizer ? summarizer(record) : genericSummary(record);
  if (summary === undefined) return undefined;
  const redacted = truncate(redactText(summary), TOOL_ARGS_LIMIT * 2);
  return redacted.length > 0 ? redacted : undefined;
}

/** The Agent's own task list, surfaced in the progress rail. */
export function extractTodos(input: unknown): TodoEntry[] | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const todos = (input as Record<string, unknown>).todos;
  if (!Array.isArray(todos)) return undefined;
  const entries: TodoEntry[] = [];
  for (const entry of todos) {
    if (entries.length >= TODO_LIMIT) break;
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const content = str(record.content);
    const status = record.status;
    if (content === undefined) continue;
    if (
      status !== "pending" &&
      status !== "in_progress" &&
      status !== "completed"
    ) {
      continue;
    }
    entries.push({
      content: truncate(redactText(content), TODO_CONTENT_LIMIT),
      status,
    });
  }
  return entries.length > 0 ? entries : undefined;
}

function joinTextBlocks(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("");
  return text.length > 0 ? text : undefined;
}

export interface ToolResultSummary {
  status: ToolStatus;
  preview?: string;
  errorCode?: string;
  errorMessage?: string;
}

// Ark reports failure as a boolean plus a JSON envelope inside the text body;
// there is no `status` string field on the wire.
function parseErrorEnvelope(
  text: string,
): { code?: string; message?: string } | undefined {
  if (!text.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const error = (parsed as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  const code = str(record.code);
  const message = str(record.message);
  return {
    ...(code === undefined ? {} : { code: truncate(code, TOOL_ARGS_LIMIT) }),
    ...(message === undefined
      ? {}
      : { message: truncate(redactText(message), TOOL_ARGS_LIMIT * 2) }),
  };
}

export function summarizeToolResult(
  content: unknown,
  isError: unknown,
): ToolResultSummary {
  const failed = isError === true;
  const text = joinTextBlocks(content);
  const envelope = text === undefined ? undefined : parseErrorEnvelope(text);
  return {
    status: failed ? "failed" : "ok",
    ...(text === undefined ? {} : { preview: redactPreview(text) }),
    ...(envelope?.code === undefined ? {} : { errorCode: envelope.code }),
    ...(envelope?.message === undefined
      ? {}
      : { errorMessage: envelope.message }),
  };
}

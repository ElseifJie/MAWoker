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
];

const IDENTIFIER = /[A-Za-z0-9_-]+/g;
const IDENTIFIER_CHARACTER = /[A-Za-z0-9_-]/;
const SENSITIVE_ASSIGNMENT_KEYS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "apikey",
  "api_key",
  "api-key",
  "accesskey",
  "access_key",
  "access-key",
  "secretkey",
  "secret_key",
  "secret-key",
  "secretaccesskey",
  "secret_access_key",
  "secret-access-key",
  "password",
  "secret",
  "token",
  "credential",
  "credentials",
  "auth",
  "session",
  "ark_api_key",
  "ark-api-key",
]);

export interface SensitiveAssignment {
  key: string;
  start: number;
  end: number;
  replacement: string;
}

function escapedQuoteBefore(
  text: string,
  keyStart: number,
): { start: number; slashCount: number } | undefined {
  if (text[keyStart - 1] !== '"') return undefined;
  let start = keyStart - 1;
  while (start > 0 && text[start - 1] === "\\") start -= 1;
  return { start, slashCount: keyStart - 1 - start };
}

function quoteAt(
  text: string,
  start: number,
): { end: number; slashCount: number } | undefined {
  let quote = start;
  while (text[quote] === "\\") quote += 1;
  if (text[quote] !== '"') return undefined;
  return { end: quote + 1, slashCount: quote - start };
}

function closingQuoteStart(
  text: string,
  start: number,
  slashCount: number,
): number | undefined {
  for (
    let quote = text.indexOf('"', start);
    quote >= 0;
    quote = text.indexOf('"', quote + 1)
  ) {
    let slash = quote;
    while (slash > start && text[slash - 1] === "\\") slash -= 1;
    if (quote - slash === slashCount) return slash;
  }
  return undefined;
}

/**
 * Finds exact sensitive-key assignments in plain text, JSON, and JSON escaped
 * inside a string. Identifier runs include letters, digits, `_`, and `-`.
 */
export function detectSensitiveAssignments(
  text: string,
): SensitiveAssignment[] {
  const assignments: SensitiveAssignment[] = [];
  IDENTIFIER.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IDENTIFIER.exec(text)) !== null) {
    const key = match[0].toLowerCase();
    if (!SENSITIVE_ASSIGNMENT_KEYS.has(key)) continue;

    const keyStart = match.index;
    const keyEnd = IDENTIFIER.lastIndex;
    const openingQuote = escapedQuoteBefore(text, keyStart);
    let cursor = keyEnd;
    if (openingQuote) {
      const closingKeyQuote = quoteAt(text, cursor);
      if (
        !closingKeyQuote ||
        closingKeyQuote.slashCount !== openingQuote.slashCount ||
        (openingQuote.start > 0 &&
          IDENTIFIER_CHARACTER.test(text[openingQuote.start - 1]!))
      ) {
        continue;
      }
      cursor = closingKeyQuote.end;
    }

    while (/\s/.test(text[cursor] ?? "")) cursor += 1;
    if (text[cursor] !== ":" && text[cursor] !== "=") continue;
    cursor += 1;
    while (/\s/.test(text[cursor] ?? "")) cursor += 1;
    const valueStart = cursor;

    const scheme = /^(?:bearer|basic)(?=\s)/i.exec(text.slice(cursor));
    if (scheme) {
      cursor += scheme[0].length;
      while (/\s/.test(text[cursor] ?? "")) cursor += 1;
    }

    const openingValueQuote = quoteAt(text, cursor);
    if (openingValueQuote) {
      const closingValueQuote = closingQuoteStart(
        text,
        openingValueQuote.end,
        openingValueQuote.slashCount,
      );
      if (closingValueQuote !== undefined) {
        const valueEnd = closingValueQuote + openingValueQuote.slashCount + 1;
        assignments.push({
          key,
          start: openingQuote
            ? scheme
              ? valueStart
              : openingValueQuote.end
            : keyEnd,
          end: openingQuote && !scheme ? closingValueQuote : valueEnd,
          replacement: openingQuote ? "[redacted]" : ": [redacted]",
        });
        IDENTIFIER.lastIndex = valueEnd;
        continue;
      }
    }

    let valueEnd = cursor;
    while (valueEnd < text.length && !/[\s,;}\]]/.test(text[valueEnd]!)) {
      valueEnd += 1;
    }
    if (valueEnd === cursor) continue;
    assignments.push({
      key,
      start: openingQuote ? valueStart : keyEnd,
      end: valueEnd,
      replacement: openingQuote ? "[redacted]" : ": [redacted]",
    });
    IDENTIFIER.lastIndex = valueEnd;
  }
  return assignments;
}

function redactSensitiveAssignments(text: string): string {
  const assignments = detectSensitiveAssignments(text);
  if (assignments.length === 0) return text;
  let redacted = "";
  let cursor = 0;
  for (const assignment of assignments) {
    redacted += text.slice(cursor, assignment.start) + assignment.replacement;
    cursor = assignment.end;
  }
  return redacted + text.slice(cursor);
}

/**
 * Every denied key is stored through the same normalization the lookup uses, so
 * `access_key` in a payload cannot slip past by normalizing to a spelling the
 * set does not contain.
 */
function normalizeArgKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, "");
}

const DENIED_ARG_KEYS = new Set(
  [
    "authorization",
    "cookie",
    "credential",
    "credentials",
    "password",
    "secret",
    "secret_key",
    "secretkey",
    "secret_access_key",
    "secretaccesskey",
    "token",
    "apikey",
    "api_key",
    "accesskey",
    "access_key",
    "session",
    "auth",
  ].map(normalizeArgKey),
);

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
  return redactSensitiveAssignments(out);
}

/** Erases credentials and rewrites sandbox paths to what the owner may see. */
export function redactText(text: string): string {
  return redactCredentials(text).replace(ABSOLUTE_PATH, replacePath);
}

/** Redacts then truncates free-form tool output for display. */
export function redactPreview(content: string): string {
  return truncate(redactText(content), TOOL_PREVIEW_LIMIT);
}

/** Re-projects an already-public tool argument summary. */
export function redactToolArgsSummary(summary: string): string | undefined {
  const redacted = truncate(redactText(summary), TOOL_ARGS_LIMIT * 2);
  return redacted.length > 0 ? redacted : undefined;
}

/** Applies the same bound used when extracting an Ark tool error code. */
export function boundToolErrorCode(code: string): string {
  return truncate(code, TOOL_ARGS_LIMIT);
}

/** Re-projects an already-public tool error message. */
export function redactToolErrorMessage(message: string): string {
  return truncate(redactText(message), TOOL_ARGS_LIMIT * 2);
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
    if (DENIED_ARG_KEYS.has(normalizeArgKey(key))) continue;
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
  return redactToolArgsSummary(summary);
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
    ...(code === undefined ? {} : { code: boundToolErrorCode(code) }),
    ...(message === undefined
      ? {}
      : { message: redactToolErrorMessage(message) }),
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

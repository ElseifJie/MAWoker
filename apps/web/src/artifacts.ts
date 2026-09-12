import type { ArtifactSummary } from "./api.js";

export type ArtifactKind =
  | "markdown"
  | "text"
  | "image"
  | "html"
  | "csv"
  | "pdf"
  | "word"
  | "slides"
  | "other";

/** Above this the browser downloads instead of previewing; a huge CSV would hang the tab. */
export const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Office and PDF documents are binary and rendered by their own engine; the
 * text cap above is about DOM text nodes, not file size, so they get more room.
 */
export const DOCUMENT_PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

const TEXT_KINDS: ReadonlySet<ArtifactKind> = new Set([
  "markdown",
  "text",
  "image",
  "html",
  "csv",
]);

const DOCUMENT_KINDS: ReadonlySet<ArtifactKind> = new Set([
  "pdf",
  "word",
  "slides",
]);

export function canPreview(
  artifact: Pick<ArtifactSummary, "name" | "mimeType" | "sizeBytes">,
): boolean {
  const kind = artifactKind(artifact);
  if (TEXT_KINDS.has(kind)) return artifact.sizeBytes <= PREVIEW_MAX_BYTES;
  if (DOCUMENT_KINDS.has(kind)) {
    return artifact.sizeBytes <= DOCUMENT_PREVIEW_MAX_BYTES;
  }
  return false;
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index + 1).toLowerCase();
}

/**
 * Classifies by MIME type first and falls back to the extension, because Ark
 * reports `application/octet-stream` for files the Agent wrote itself.
 *
 * Legacy binary formats (`.doc`, `.ppt`) stay download-only: the in-browser
 * renderers only understand the OOXML zip containers (`.docx`, `.pptx`), and
 * misclassifying them would promise a preview that cannot render.
 */
export function artifactKind(
  artifact: Pick<ArtifactSummary, "name" | "mimeType">,
): ArtifactKind {
  const mime = artifact.mimeType.toLowerCase();
  if (mime === "text/markdown") return "markdown";
  if (mime === "text/csv") return "csv";
  if (mime === "text/html") return "html";
  if (mime === "application/pdf") return "pdf";
  if (mime.includes("wordprocessingml")) return "word";
  if (mime.includes("presentationml")) return "slides";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("text/")) return "text";

  switch (extensionOf(artifact.name)) {
    case "md":
    case "markdown":
      return "markdown";
    case "csv":
    case "tsv":
      return "csv";
    case "html":
    case "htm":
      return "html";
    case "pdf":
      return "pdf";
    case "docx":
      return "word";
    case "pptx":
      return "slides";
    case "txt":
    case "log":
    case "json":
    case "yaml":
    case "yml":
    case "xml":
      return "text";
    default:
      return "other";
  }
}

/** Downloads go through the API, which streams with Content-Disposition. */
export function artifactDownloadUrl(id: string): string {
  return `/api/v1/artifacts/${encodeURIComponent(id)}/download`;
}

/**
 * RFC 4180 parser: quoted fields may contain commas, newlines and `""` escapes.
 * Written here rather than pulled in, because the alternatives either ship a
 * spreadsheet engine or ignore quoting.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char !== '"') {
        field += char;
        continue;
      }
      if (text[index + 1] === '"') {
        field += '"';
        index += 1;
        continue;
      }
      quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\r") continue;
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

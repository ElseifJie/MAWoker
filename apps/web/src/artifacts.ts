import type { ArtifactSummary } from "./api.js";

export type ArtifactKind =
  "markdown" | "text" | "image" | "html" | "csv" | "pdf" | "other";

/** Above this the browser downloads instead of previewing; a huge CSV would hang the tab. */
export const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

const INLINE_KINDS: ReadonlySet<ArtifactKind> = new Set([
  "markdown",
  "text",
  "image",
  "html",
  "csv",
]);

export function canPreview(
  artifact: Pick<ArtifactSummary, "name" | "mimeType" | "sizeBytes">,
): boolean {
  return (
    INLINE_KINDS.has(artifactKind(artifact)) &&
    artifact.sizeBytes <= PREVIEW_MAX_BYTES
  );
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index + 1).toLowerCase();
}

/**
 * Classifies by MIME type first and falls back to the extension, because Ark
 * reports `application/octet-stream` for files the Agent wrote itself.
 *
 * Office and PDF formats deliberately classify as something we do not render
 * inline: the npm `xlsx` package is frozen at a release with unpatched
 * prototype-pollution and ReDoS advisories, and no other in-browser reader for
 * docx/pptx is worth the supply-chain surface. Those are download-only.
 */
export function artifactKind(
  artifact: Pick<ArtifactSummary, "name" | "mimeType">,
): ArtifactKind {
  const mime = artifact.mimeType.toLowerCase();
  if (mime === "text/markdown") return "markdown";
  if (mime === "text/csv") return "csv";
  if (mime === "text/html") return "html";
  if (mime === "application/pdf") return "pdf";
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

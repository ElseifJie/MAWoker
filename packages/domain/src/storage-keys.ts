import type { FileOrigin } from "./drive-files.js";

/**
 * The single place that decides where a byte object lives in TOS. Centralised so
 * a future layout change (for example relocating an object when the drive gains
 * folders) has exactly one caller to update.
 *
 * The key embeds the tenant and the origin but deliberately not the Session:
 * bytes belong to the user's drive and must outlive the Session that produced
 * them. Session isolation is enforced by association rows and API ownership
 * checks, never by parsing this string.
 *
 * `{origin}` is a low-cardinality segment so TOS lifecycle rules can treat
 * uploads, Agent artifacts and imports differently without scanning the index.
 */
export function driveObjectKey(input: {
  ownerUserId: string;
  origin: FileOrigin;
  driveFileId: string;
  name: string;
}): string {
  return `tenants/${input.ownerUserId}/drive/${input.origin}/${input.driveFileId}/${sanitizeObjectName(input.name)}`;
}

/**
 * Keeps a human-readable trailing segment while guaranteeing the result is a
 * single, non-traversing path segment. The drive file id already makes the key
 * unique, so this only has to be safe, not collision-free.
 */
export function sanitizeObjectName(name: string): string {
  const normalized = name.trim().normalize("NFKC");
  const withoutControls = Array.from(normalized, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? "_" : character;
  }).join("");
  const segment = withoutControls
    .replace(/[/\\]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 180);
  return segment || "file";
}

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class McpUrlUnsafeError extends Error {
  readonly code = "MCP_URL_UNSAFE";
  constructor(message = "MCP URL is not allowed") {
    super(message);
    this.name = "McpUrlUnsafeError";
  }
}

export interface McpUrlValidationOptions {
  /** Injected for tests; defaults to dns.lookup(..., { all: true }). */
  resolve?: (hostname: string) => Promise<Array<{ address: string }>>;
  /** Optional exact/subdomain allowlist. Empty means any public host. */
  allowedHosts?: readonly string[];
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe80")) return true;
  if (normalized.startsWith("::ffff:")) {
    return isPrivateIpv4(normalized.slice("::ffff:".length));
  }
  return false;
}

function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateIpv4(address);
  if (version === 6) return isPrivateIpv6(address);
  return false;
}

function normalizeHost(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");
}

function isLocalName(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "metadata.google.internal"
  );
}

function hostAllowed(host: string, allowed: readonly string[]): boolean {
  return allowed.some((entry) => {
    const normalized = normalizeHost(entry);
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

/**
 * Validates a remote MCP URL before it enters the registry. DNS answers are
 * checked too, so a public hostname pointing at loopback or RFC1918 space is
 * rejected. The caller must still re-check egress at connection time.
 */
export async function validateMcpUrl(
  input: string,
  options: McpUrlValidationOptions = {},
): Promise<string> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new McpUrlUnsafeError("MCP URL is malformed");
  }
  if (url.protocol !== "https:") {
    throw new McpUrlUnsafeError("MCP URL must use HTTPS");
  }
  if (url.username || url.password) {
    throw new McpUrlUnsafeError("MCP URL must not contain credentials");
  }
  const host = normalizeHost(url.hostname);
  if (!host || isLocalName(host)) {
    throw new McpUrlUnsafeError("MCP URL must target a public host");
  }
  if (options.allowedHosts && options.allowedHosts.length > 0) {
    if (!hostAllowed(host, options.allowedHosts)) {
      throw new McpUrlUnsafeError("MCP host is not in the allowlist");
    }
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new McpUrlUnsafeError("MCP URL must not target a private address");
    }
  } else {
    let addresses: Array<{ address: string }>;
    try {
      addresses = await (options.resolve?.(host) ??
        lookup(host, { all: true, verbatim: true }));
    } catch {
      throw new McpUrlUnsafeError("MCP host could not be resolved");
    }
    if (
      addresses.length === 0 ||
      addresses.some((entry) => isPrivateAddress(entry.address))
    ) {
      throw new McpUrlUnsafeError("MCP host resolves to a private address");
    }
  }
  url.hash = "";
  return url.toString();
}

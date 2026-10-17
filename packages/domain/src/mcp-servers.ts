import { ResourceNotFoundError } from "./errors.js";
import { McpUrlUnsafeError, validateMcpUrl } from "./mcp-url.js";

export interface McpServerRecord {
  id: string;
  ownerUserId: string;
  name: string;
  url: string;
  status: "active" | "disabled";
  createdAt: Date;
  updatedAt: Date;
}

export interface McpServerRepository {
  create(input: {
    id: string;
    ownerUserId: string;
    name: string;
    url: string;
    now: Date;
  }): PromiseLike<McpServerRecord | undefined>;
  listOwned(ownerUserId: string): PromiseLike<McpServerRecord[]>;
  setStatus(input: {
    ownerUserId: string;
    id: string;
    status: "active" | "disabled";
    now: Date;
  }): PromiseLike<McpServerRecord | undefined>;
  delete(ownerUserId: string, id: string): PromiseLike<boolean>;
}

export class McpServerNameConflictError extends Error {
  readonly code = "MCP_NAME_CONFLICT";
  constructor() {
    super("An MCP server with this name already exists");
    this.name = "McpServerNameConflictError";
  }
}

export class McpServerService {
  constructor(
    private readonly dependencies: {
      repository: McpServerRepository;
      createId: () => string;
      validateUrl?: typeof validateMcpUrl;
      allowedHosts?: readonly string[];
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  async create(
    ownerUserId: string,
    input: { name: string; url: string },
  ): Promise<McpServerRecord> {
    const name = input.name.trim();
    if (name.length === 0 || name.length > 80) {
      throw new McpUrlUnsafeError("MCP server name must be 1–80 characters");
    }
    const validate = this.dependencies.validateUrl ?? validateMcpUrl;
    const url = await validate(
      input.url,
      this.dependencies.allowedHosts
        ? { allowedHosts: this.dependencies.allowedHosts }
        : {},
    );
    const row = await this.dependencies.repository.create({
      id: this.dependencies.createId(),
      ownerUserId,
      name,
      url,
      now: this.now(),
    });
    if (!row) throw new McpServerNameConflictError();
    return row;
  }

  list(ownerUserId: string): PromiseLike<McpServerRecord[]> {
    return this.dependencies.repository.listOwned(ownerUserId);
  }

  async setEnabled(
    ownerUserId: string,
    id: string,
    enabled: boolean,
  ): Promise<McpServerRecord> {
    const row = await this.dependencies.repository.setStatus({
      ownerUserId,
      id,
      status: enabled ? "active" : "disabled",
      now: this.now(),
    });
    if (!row) throw new ResourceNotFoundError();
    return row;
  }

  async delete(ownerUserId: string, id: string): Promise<void> {
    const deleted = await this.dependencies.repository.delete(ownerUserId, id);
    if (!deleted) throw new ResourceNotFoundError();
  }
}

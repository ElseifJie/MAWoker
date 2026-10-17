import { ResourceNotFoundError } from "./errors.js";
import { McpUrlUnsafeError, validateMcpUrl } from "./mcp-url.js";

export interface NotificationChannelRecord {
  id: string;
  ownerUserId: string;
  name: string;
  type: "webhook";
  url: string;
  enabled: boolean;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NotificationChannelRepository {
  create(input: {
    id: string;
    ownerUserId: string;
    name: string;
    url: string;
    now: Date;
  }): PromiseLike<NotificationChannelRecord | undefined>;
  listOwned(ownerUserId: string): PromiseLike<NotificationChannelRecord[]>;
  listEnabled(ownerUserId: string): PromiseLike<NotificationChannelRecord[]>;
  setEnabled(input: {
    ownerUserId: string;
    id: string;
    enabled: boolean;
    now: Date;
  }): PromiseLike<NotificationChannelRecord | undefined>;
  updateError(input: {
    ownerUserId: string;
    id: string;
    errorCode: string | null;
    now: Date;
  }): PromiseLike<void>;
  delete(ownerUserId: string, id: string): PromiseLike<boolean>;
}

export class NotificationChannelNameConflictError extends Error {
  readonly code = "CHANNEL_NAME_CONFLICT";
  constructor() {
    super("A notification channel with this name already exists");
    this.name = "NotificationChannelNameConflictError";
  }
}

export class InvalidChannelUrlError extends Error {
  readonly code = "CHANNEL_URL_UNSAFE";
  constructor(message: string) {
    super(message);
    this.name = "InvalidChannelUrlError";
  }
}

export function maskWebhookUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const suffix = parsed.pathname.slice(-4).padStart(4, "*");
    return `${parsed.protocol}//${parsed.host}/…${suffix}`;
  } catch {
    return "…";
  }
}

export class NotificationChannelService {
  constructor(
    private readonly dependencies: {
      repository: NotificationChannelRepository;
      createId: () => string;
      validateUrl?: typeof validateMcpUrl;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  async create(
    ownerUserId: string,
    input: { name: string; url: string },
  ): Promise<NotificationChannelRecord> {
    const name = input.name.trim();
    if (name.length === 0 || name.length > 80) {
      throw new InvalidChannelUrlError("Channel name must be 1–80 characters");
    }
    let url: string;
    try {
      const validate = this.dependencies.validateUrl ?? validateMcpUrl;
      url = await validate(input.url);
    } catch (error) {
      if (error instanceof McpUrlUnsafeError) {
        throw new InvalidChannelUrlError(error.message);
      }
      throw error;
    }
    const row = await this.dependencies.repository.create({
      id: this.dependencies.createId(),
      ownerUserId,
      name,
      url,
      now: this.now(),
    });
    if (!row) throw new NotificationChannelNameConflictError();
    return row;
  }

  list(ownerUserId: string): PromiseLike<NotificationChannelRecord[]> {
    return this.dependencies.repository.listOwned(ownerUserId);
  }

  async setEnabled(
    ownerUserId: string,
    id: string,
    enabled: boolean,
  ): Promise<NotificationChannelRecord> {
    const row = await this.dependencies.repository.setEnabled({
      ownerUserId,
      id,
      enabled,
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

export const CONSENT_DOCUMENTS = ["terms", "privacy"] as const;
export type ConsentDocument = (typeof CONSENT_DOCUMENTS)[number];

/** Bumped whenever the published privacy/terms text changes. */
export const CONSENT_VERSION = "2026-10-18";

export interface ConsentRecord {
  document: string;
  version: string;
  acceptedAt: Date;
}

export interface ConsentRepository {
  listForUser(userId: string): PromiseLike<ConsentRecord[]>;
  record(input: {
    userId: string;
    document: string;
    version: string;
    now: Date;
  }): PromiseLike<ConsentRecord>;
}

export class ConsentInvalidError extends Error {
  constructor() {
    super("Consent document or version is not current");
    this.name = "ConsentInvalidError";
  }
}

function isConsentDocument(value: unknown): value is ConsentDocument {
  return (
    typeof value === "string" &&
    (CONSENT_DOCUMENTS as readonly string[]).includes(value)
  );
}

export class ConsentService {
  constructor(
    private readonly dependencies: {
      repository: ConsentRepository;
      now?: () => Date;
    },
  ) {}

  async list(userId: string) {
    return {
      consents: await this.dependencies.repository.listForUser(userId),
      currentVersion: CONSENT_VERSION,
      documents: CONSENT_DOCUMENTS,
    };
  }

  async accept(
    userId: string,
    input: { document: unknown; version: unknown },
  ): Promise<ConsentRecord> {
    if (
      !isConsentDocument(input.document) ||
      input.version !== CONSENT_VERSION
    ) {
      throw new ConsentInvalidError();
    }
    return this.dependencies.repository.record({
      userId,
      document: input.document,
      version: CONSENT_VERSION,
      now: this.dependencies.now?.() ?? new Date(),
    });
  }
}

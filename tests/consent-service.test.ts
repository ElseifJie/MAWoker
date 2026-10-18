import { describe, expect, it, vi } from "vitest";
import {
  CONSENT_VERSION,
  ConsentInvalidError,
  ConsentService,
  type ConsentRecord,
} from "../packages/domain/src/consents.js";

function repository(records: ConsentRecord[] = []) {
  return {
    listForUser: vi.fn(async () => records),
    record: vi.fn(
      async (input: {
        userId: string;
        document: ConsentRecord["document"];
        version: string;
        now: Date;
      }) => ({
        document: input.document,
        version: input.version,
        acceptedAt: input.now,
      }),
    ),
  };
}

describe("ConsentService", () => {
  it("lists the accepted versions and the current documents", async () => {
    const records: ConsentRecord[] = [
      {
        document: "privacy",
        version: CONSENT_VERSION,
        acceptedAt: new Date("2026-10-18T00:00:00.000Z"),
      },
    ];
    const repo = repository(records);
    const service = new ConsentService({ repository: repo });

    await expect(service.list("user-1")).resolves.toEqual({
      consents: records,
      currentVersion: CONSENT_VERSION,
      documents: ["terms", "privacy"],
    });
    expect(repo.listForUser).toHaveBeenCalledWith("user-1");
  });

  it("records the current version with the injected clock", async () => {
    const repo = repository();
    const now = new Date("2026-10-18T09:00:00.000Z");
    const service = new ConsentService({ repository: repo, now: () => now });

    await expect(
      service.accept("user-1", {
        document: "privacy",
        version: CONSENT_VERSION,
      }),
    ).resolves.toEqual({
      document: "privacy",
      version: CONSENT_VERSION,
      acceptedAt: now,
    });
    expect(repo.record).toHaveBeenCalledWith({
      userId: "user-1",
      document: "privacy",
      version: CONSENT_VERSION,
      now,
    });
  });

  it("rejects an unknown document or a stale version", async () => {
    const repo = repository();
    const service = new ConsentService({ repository: repo });

    await expect(
      service.accept("user-1", {
        document: "marketing",
        version: CONSENT_VERSION,
      }),
    ).rejects.toBeInstanceOf(ConsentInvalidError);
    await expect(
      service.accept("user-1", { document: "privacy", version: "2025-01-01" }),
    ).rejects.toBeInstanceOf(ConsentInvalidError);
    expect(repo.record).not.toHaveBeenCalled();
  });
});

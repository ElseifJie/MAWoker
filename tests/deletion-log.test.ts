import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  DeletionLogStore,
  type DeletionLogIntent,
} from "../packages/domain/src/deletion-log.js";

const intent: DeletionLogIntent = {
  kind: "session",
  deletionRequestId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  sessionId: "00000000-0000-4000-8000-000000000003",
  arkSessionId: "ark-session-1",
  scope: "session_history_and_artifacts",
  requestedAt: "2026-10-12T00:00:00.000Z",
};

function storage(initial: Map<string, string> = new Map()) {
  return {
    map: initial,
    write: vi.fn(async (key: string, stream: Readable) => {
      const chunks: string[] = [];
      for await (const chunk of stream) chunks.push(String(chunk));
      initial.set(key, chunks.join(""));
    }),
    openRead: vi.fn(async (key: string) => {
      const body = initial.get(key);
      if (body === undefined) throw new Error("not found");
      return Readable.from([body]);
    }),
  };
}

describe("DeletionLogStore", () => {
  it("confirms an appended intent and reads it back by request id", async () => {
    const store = new storage();
    const log = new DeletionLogStore({ storage: store });

    await expect(log.appendAndConfirm(intent)).resolves.toEqual({
      confirmed: true,
    });
    expect(store.write).toHaveBeenCalledWith(
      `deletion-log/${intent.deletionRequestId}.json`,
      expect.any(Readable),
      { contentType: "application/json" },
    );
    await expect(log.read(intent.deletionRequestId)).resolves.toEqual(intent);
  });

  it("overwrites the same object on retry, so replays never fork the log", async () => {
    const store = new storage();
    const log = new DeletionLogStore({ storage: store });

    await log.appendAndConfirm(intent);
    await log.appendAndConfirm(intent);

    expect(store.write).toHaveBeenCalledTimes(2);
    expect(store.map.size).toBe(1);
  });

  it("reports unconfirmed when the write fails or reads back mismatched", async () => {
    const broken = {
      write: vi.fn(async () => {
        throw new Error("tos unavailable");
      }),
      openRead: vi.fn(),
    };
    await expect(
      new DeletionLogStore({ storage: broken }).appendAndConfirm(intent),
    ).resolves.toEqual({
      confirmed: false,
      reason: "DELETION_LOG_UNAVAILABLE",
    });

    // The write lands but the read-back returns a different identity: the
    // confirm step must refuse to trust it.
    const tampered = {
      write: vi.fn(async () => undefined),
      openRead: vi.fn(async () =>
        Readable.from([JSON.stringify({ ...intent, userId: "someone-else" })]),
      ),
    };
    await expect(
      new DeletionLogStore({ storage: tampered }).appendAndConfirm(intent),
    ).resolves.toEqual({ confirmed: false, reason: "DELETION_LOG_MISMATCH" });
  });

  it("refuses to read an entry whose body names a different request", async () => {
    const store = storage(
      new Map([
        [
          `deletion-log/${intent.deletionRequestId}.json`,
          JSON.stringify({ ...intent, deletionRequestId: "other-request" }),
        ],
      ]),
    );
    await expect(
      new DeletionLogStore({ storage: store }).read(intent.deletionRequestId),
    ).resolves.toBeUndefined();
  });
});

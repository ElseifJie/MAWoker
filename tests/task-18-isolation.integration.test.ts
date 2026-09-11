import { describe, expect, it } from "vitest";
import { QuotaExceededError } from "../packages/db/src/index.js";
import { ResourceNotFoundError } from "../packages/domain/src/index.js";
import {
  collectBytes,
  createTask18DatabaseHarness,
} from "./support/task-18-database.js";

describe("Task 18 tenant and quota acceptance", () => {
  it("isolates two users from each other and the administrator across every tenant resource", async () => {
    const harness = await createTask18DatabaseHarness();
    try {
      const matrix = [
        {
          kind: "personal Agent",
          repository: harness.repositories.personalAgents,
          firstId: harness.first.personalAgentId,
          secondId: harness.second.personalAgentId,
        },
        {
          kind: "Session",
          repository: harness.repositories.sessions,
          firstId: harness.first.sessionId,
          secondId: harness.second.sessionId,
        },
        {
          kind: "upload",
          repository: harness.repositories.sessionInputs,
          firstId: harness.first.uploadId,
          secondId: harness.second.uploadId,
        },
        {
          kind: "artifact",
          repository: harness.repositories.artifacts,
          firstId: harness.first.artifactId,
          secondId: harness.second.artifactId,
        },
        {
          kind: "usage",
          repository: harness.repositories.usage,
          firstId: harness.first.usageId,
          secondId: harness.second.usageId,
        },
      ] as const;

      for (const entry of matrix) {
        await expect(
          entry.repository.findOwned(harness.first.userId, entry.firstId),
          entry.kind,
        ).resolves.toBeDefined();
        await expect(
          entry.repository.findOwned(harness.second.userId, entry.secondId),
          entry.kind,
        ).resolves.toBeDefined();
        await expect(
          entry.repository.findOwned(harness.first.userId, entry.secondId),
          entry.kind,
        ).resolves.toBeUndefined();
        await expect(
          entry.repository.findOwned(harness.second.userId, entry.firstId),
          entry.kind,
        ).resolves.toBeUndefined();
        await expect(
          entry.repository.findOwned(harness.adminId, entry.firstId),
          entry.kind,
        ).resolves.toBeUndefined();
      }

      await expect(
        harness.repositories.platformAgents.findAssignedToUser(
          harness.first.userId,
          harness.platformAgentId,
        ),
      ).resolves.toBeDefined();
      await expect(
        harness.repositories.platformAgents.findAssignedToUser(
          harness.second.userId,
          harness.platformAgentId,
        ),
      ).resolves.toBeUndefined();
      await expect(
        harness.repositories.platformAgents.findAssignedToUser(
          harness.adminId,
          harness.platformAgentId,
        ),
      ).resolves.toBeUndefined();

      await expect(
        harness.artifacts.download(
          harness.first.artifactId,
          harness.second.userId,
        ),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
      await expect(
        harness.artifacts.download(harness.first.artifactId, harness.adminId),
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
    } finally {
      await harness.close();
    }
  });

  it("atomically admits one concurrent task and keeps non-execution operations available after monthly exhaustion", async () => {
    const harness = await createTask18DatabaseHarness();
    try {
      const admissions = await Promise.allSettled([
        harness.repositories.quotas.reserveSession({
          userId: harness.second.userId,
          reservationId: harness.ids(),
          expiresAt: new Date(Date.now() + 60_000),
        }),
        harness.repositories.quotas.reserveSession({
          userId: harness.second.userId,
          reservationId: harness.ids(),
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ]);
      expect(
        admissions.filter(({ status }) => status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        admissions.filter(({ status }) => status === "rejected"),
      ).toHaveLength(1);
      expect(
        admissions.find(({ status }) => status === "rejected"),
      ).toMatchObject({
        reason: new QuotaExceededError("concurrent_sessions"),
      });

      await expect(
        harness.repositories.sessionLifecycle.beginMessage(
          harness.first.userId,
          harness.first.sessionId,
        ),
      ).rejects.toMatchObject({
        name: "QuotaExceededError",
        dimension: "monthly_tokens",
      });

      await expect(
        harness.sessions.list(harness.first.userId, false),
      ).resolves.toEqual([
        expect.objectContaining({ id: harness.first.sessionId }),
      ]);
      await expect(
        harness.sessions.archive(harness.first.sessionId, harness.first.userId),
      ).resolves.toMatchObject({
        id: harness.first.sessionId,
        archivedAt: expect.anything(),
      });
      await expect(
        harness.sessions.list(harness.first.userId, true),
      ).resolves.toHaveLength(1);
      await expect(
        harness.sessions.restore(harness.first.sessionId, harness.first.userId),
      ).resolves.toMatchObject({
        id: harness.first.sessionId,
        archivedAt: null,
      });

      const download = await harness.artifacts.download(
        harness.first.artifactId,
        harness.first.userId,
      );
      await expect(collectBytes(download.stream)).resolves.toEqual(
        new TextEncoder().encode("first artifact"),
      );
      await expect(
        harness.sessions.requestDelete(
          harness.first.sessionId,
          harness.first.userId,
        ),
      ).resolves.toMatchObject({
        id: harness.first.sessionId,
        deletionState: "pending",
      });
    } finally {
      await harness.close();
    }
  });
});

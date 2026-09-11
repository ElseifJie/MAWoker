import { describe, expect, it, vi } from "vitest";
import { createRepositories } from "../packages/db/src/index.js";

describe("quota repository", () => {
  it("normalizes PostgreSQL bigint quota values to numbers", async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [
        {
          personalAgentLimit: 10,
          concurrentSessionLimit: 2,
          dailySessionLimit: 25,
          monthlyTokenLimit: "1000000000",
        },
      ],
    });
    const repositories = createRepositories({ execute });

    await expect(repositories.quotas.getEffective("user-1")).resolves.toEqual({
      personalAgentLimit: 10,
      concurrentSessionLimit: 2,
      dailySessionLimit: 25,
      monthlyTokenLimit: 1_000_000_000,
    });
  });
});

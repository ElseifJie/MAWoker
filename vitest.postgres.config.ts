import { defineConfig } from "vitest/config";

/**
 * The real-PostgreSQL suites create and drop their own schemas, so they must
 * never share a database with development or production data. Running them
 * one file at a time keeps contention assertions deterministic.
 */
const postgresSuites = [
  "tests/artifact-copy-lifecycle.integration.test.ts",
  "tests/artifact-postgres-contention.integration.test.ts",
  "tests/db-postgres-contention.integration.test.ts",
  "tests/durable-submissions.integration.test.ts",
  "tests/file-reuse-postgres.integration.test.ts",
  "tests/job-lease-postgres-contention.integration.test.ts",
  "tests/memory-postgres-contention.integration.test.ts",
  "tests/session-delivery-postgres.integration.test.ts",
  "tests/session-history-postgres.integration.test.ts",
  "tests/session-quota-postgres-contention.integration.test.ts",
];

if (!process.env.TEST_POSTGRES_URL) {
  throw new Error(
    "TEST_POSTGRES_URL must point at an isolated PostgreSQL database; " +
      "the real-PostgreSQL suites create and drop their own schemas.",
  );
}

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup-webstorage.ts"],
    include: postgresSuites,
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    poolOptions: {
      forks: { maxForks: 1, minForks: 1 },
    },
  },
});

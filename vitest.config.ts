import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup-webstorage.ts"],
    exclude: ["node_modules/**", "tests/e2e/**"],
    // PGlite integration tests take ~3s alone but ~20s under full file
    // parallelism, so the 5s default failed them on a loaded machine.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Each PGlite file starts a WASM Postgres and foundation.test.ts spawns the
    // production API as a subprocess; ten of those at once starved the machine.
    poolOptions: {
      forks: { maxForks: 4, minForks: 1 },
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
    },
  },
});

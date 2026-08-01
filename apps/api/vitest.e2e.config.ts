import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    setupFiles: ["./src/test/setup.ts"],
    environment: "node",
    pool: "forks",
    poolOptions: { forks: { minForks: 1, maxForks: 2 } },
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});

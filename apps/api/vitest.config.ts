import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    setupFiles: ["./src/test/setup.ts"],
    environment: "node",
    // Each file boots its own in-process Postgres, so isolate at the file level
    // and keep the pool small enough not to thrash a laptop.
    pool: "forks",
    poolOptions: { forks: { minForks: 1, maxForks: 4 } },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: [
        "src/lib/money.ts",
        "src/modules/decisions/engine.ts",
        "src/modules/payments/policyGuard.ts",
        "src/modules/payments/checkoutAdapter.ts",
        "src/modules/payments/pravaMock.ts",
        "src/modules/intake/**",
      ],
      reporter: ["text", "lcov"],
    },
  },
});

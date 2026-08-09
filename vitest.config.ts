import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          environment: "node",
          include: ["tests/contract/**/*.test.ts"],
          name: "contract",
        },
      },
      {
        test: {
          environment: "node",
          include: ["src/**/*.unit.test.ts"],
          name: "unit",
        },
      },
      {
        test: {
          environment: "jsdom",
          include: ["src/**/*.component.test.tsx"],
          name: "component",
          setupFiles: ["tests/component/setup.ts"],
        },
      },
      {
        test: {
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          name: "integration",
        },
      },
      {
        test: {
          environment: "node",
          include: ["tests/live/**/*.test.ts"],
          name: "live",
          // Live harness watchdog; not a product Run or latency threshold.
          testTimeout: 60_000,
        },
      },
    ],
  },
});

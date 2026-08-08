import { defineConfig } from "@playwright/test";

process.env["CHARAMATE_TEST_BACKGROUND"] ??= "1";

export default defineConfig({
  forbidOnly: true,
  reporter: [["list"]],
  testDir: "tests/e2e",
  timeout: 60_000,
  use: {
    trace: "retain-on-failure",
  },
});

import { defineConfig } from "@playwright/test";

// Two end-to-end projects, both against a REAL installation (compiled CLI, embedded database, real worker):
//   browser   real Chromium driving the real web UI (tests/e2e/smoke.spec.ts)
//   packaged  the npm tarball installed in a fresh directory outside the repository, driven through its CLI
//             (tests/e2e/packaged.spec.ts); needs no browser
// Both run serially: they share one machine and one installation per file.
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  outputDir: "test-results",
  reporter: [["list"], ["json", { outputFile: "test-results/e2e-report.json" }]],
  projects: [
    { name: "browser", testMatch: "smoke.spec.ts", use: { browserName: "chromium", headless: true, actionTimeout: 20_000, navigationTimeout: 30_000 } },
    { name: "packaged", testMatch: "packaged.spec.ts", timeout: 600_000 },
  ],
});

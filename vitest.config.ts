import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts", "tests/changeradar.spec.ts"],
    environment: "node",
    // Generous on purpose: several suites create two databases and run real HTTP and a worker, and a busy shared
    // machine has been observed to stretch a 4 s test past 30 s. A slow test is not a failing test.
    testTimeout: 60_000,
    hookTimeout: 90_000,
    pool: "forks",
    coverage: {
      provider: "v8",
      // Decision and service code (PRD 5b: >= 90% lines and branches): the domain library, persistence
      // services, the HTTP layer, the worker and check runner, platform code and the CLI commands.
      include: ["src/services/**/*.ts", "src/domain/**/*.ts", "src/workers/**/*.ts", "src/platform/**/*.ts", "src/api/**/*.ts", "src/commands/**/*.ts", "src/db/**/*.ts"],
      // src/cli.ts is the process entry (about 65 lines: the standard input reader with its 64 KiB cap, signal
      // wiring and the exit code) around src/commands/run.ts, which is covered in process. The entry itself is
      // covered by spawned-process tests only (tests/integration/review-round2-cli.test.ts and
      // review-round3-cli.test.ts: the stdin cap at its exact boundary, escaped output, exit codes) and by a `serve`
      // smoke test, so it is excluded from the in-process number, not from testing. src/db/pg.ts is the node-postgres adapter: it is exercised by the whole
      // integration suite when CHANGERADAR_TEST_DATABASE_URL points at PostgreSQL, and cannot run on the
      // embedded default target, so it is excluded from the embedded coverage number and covered by that run.
      exclude: ["src/cli.ts", "src/db/pg.ts", "src/web/**"],
      reporter: ["text", "json-summary"],
      // Enforced overall and per area, so a well covered area cannot hide a weak one.
      thresholds: {
        lines: 90,
        branches: 90,
        "src/services/**": { lines: 90, branches: 90 },
        "src/domain/**": { lines: 90, branches: 90 },
        "src/workers/**": { lines: 90, branches: 90 },
        "src/platform/**": { lines: 90, branches: 90 },
        "src/api/**": { lines: 90, branches: 90 },
        "src/commands/**": { lines: 90, branches: 90 },
        "src/db/**": { lines: 90, branches: 90 },
      },
    },
  },
});

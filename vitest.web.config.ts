import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Web UI and static report tests: jsdom render tests for the single page app, plus node-side tests of the HTML
// report renderer and its real-service equivalence. Coverage is measured for the UI and the report renderer
// only (`npm run test:web:coverage`); the server suite has its own config and thresholds in vitest.config.ts.
export default defineConfig({
  plugins: [react()],
  test: {
    include: ["tests/web/**/*.test.ts", "tests/web/**/*.test.tsx"],
    environment: "jsdom",
    // Starts the real API on a random loopback port with synthetic seed data (see tests/web/global-setup.ts).
    globalSetup: ["tests/web/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 90_000,
    pool: "forks",
    coverage: {
      provider: "v8",
      include: ["src/web/**/*.{ts,tsx}", "src/report/**/*.ts"],
      // main.tsx only mounts <App/> into the page; env.d.ts holds a type declaration.
      exclude: ["src/web/main.tsx", "src/web/env.d.ts"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage/web",
      thresholds: { lines: 90, branches: 90 },
    },
  },
});

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The web UI is a static single page app: `vite build` writes dist/web, which `changeradar serve` serves next to
// the API. `npm run dev:web` proxies /api to a locally running server (default port 8797) with the same origin
// rules as production, so cookies and CSRF behave the same.
export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: { outDir: "../../dist/web", emptyOutDir: true, target: "es2022", sourcemap: false },
  server: { proxy: { "/api": "http://127.0.0.1:8797" } },
});

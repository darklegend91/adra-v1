import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname } from "path";
import { fileURLToPath } from "url";

// Resolve the client/ directory from the config file's own location.
// This makes root stable whether Vite is invoked from the repo root
// (local dev: `vite --config client/vite.config.js`) or from Vercel's
// build runner — no more path-doubling with `root: "client"`.
const clientDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: clientDir,
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:5001"
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});

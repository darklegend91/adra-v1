import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname } from "path";
import { fileURLToPath } from "url";

const clientDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: clientDir,
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5001",
        changeOrigin: true,
        // Suppress ECONNREFUSED noise while the Node server is still booting.
        // Returns HTTP 503 so the client retry logic can handle it cleanly.
        configure: (proxy) => {
          proxy.on("error", (err, _req, res) => {
            if (err.code === "ECONNREFUSED") {
              if (typeof res.writeHead === "function") {
                res.writeHead(503, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ message: "Server starting…" }));
              }
            }
          });
        }
      }
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});

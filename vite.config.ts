import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Stamp the service worker cache version at build time. Every build gets a new
 * value, so the browser retires the previous offline shell as soon as the new
 * worker activates, no one has to remember to bump a literal by hand.
 */
function stampServiceWorker(): Plugin {
  let version = "";
  return {
    name: "keepsake-stamp-sw",
    apply: "build",
    configResolved(config) {
      version = `${config.command}-${Date.now().toString(36)}`;
      try {
        const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as {
          version?: string;
        };
        if (pkg.version) version = `${pkg.version}-${version}`;
      } catch {
        // package.json is optional here; the timestamp alone is unique enough.
      }
    },
    closeBundle() {
      const target = path.resolve(process.cwd(), "dist", "sw.js");
      if (!fs.existsSync(target)) return;
      const source = fs.readFileSync(target, "utf8");
      fs.writeFileSync(target, source.replaceAll("__KEEPSAKE_SW_VERSION__", version));
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), stampServiceWorker()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});

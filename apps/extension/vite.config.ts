import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import path from "node:path";
import manifest from "./src/manifest";

const BUILD_MARKER = new Date().toISOString();

export default defineConfig({
  plugins: [crx({ manifest })],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  define: {
    // Baked into the bundle at build time so the first console line
    // identifies *which* build is running. Removes ambiguity about
    // whether a chrome://extensions reload actually picked up new code.
    __BUILD_MARKER__: JSON.stringify(BUILD_MARKER),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    target: "esnext",
  },
});

import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";
import { devFs } from "./vite/dev-fs.ts";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [solid(), devFs()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    watch: { ignored: ["**/src-tauri/**", "**/dev-workspace/**"] },
  },
  build: { target: "safari16", sourcemap: true, chunkSizeWarningLimit: 1500 },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    setupFiles: ["tests/setup.ts"],
  },
});

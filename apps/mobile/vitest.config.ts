import { defineConfig } from "vitest/config";
import path from "node:path";

// Logic-only tests (state machines, gesture semantics, codecs). No React Native rendering.
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: { include: ["src/**/*.test.ts"] },
});

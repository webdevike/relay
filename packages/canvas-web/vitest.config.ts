import { defineConfig } from "vitest/config";

// One Yjs, as in the build (build.ts "one-yjs"): canvas-live's helpers import it from their own package.
export default defineConfig({ resolve: { dedupe: ["yjs"] }, test: { include: ["test/**/*.test.{ts,tsx}"] } });

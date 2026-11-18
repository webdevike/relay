import { defineConfig } from "vitest/config";

export default defineConfig({
  // The relay kit's components come from apps/desktop: they take this package's React and Mantine,
  // as build.ts bundles them.
  resolve: { dedupe: ["react", "react-dom", "@mantine/core", "@mantine/hooks"] },
  test: { include: ["test/**/*.test.{ts,tsx}"] },
});

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { name: 'browser-core', environment: 'node', include: ['src/**/*.test.ts'] },
})

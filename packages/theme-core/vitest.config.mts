import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { name: 'theme-core', environment: 'node', include: ['src/**/*.test.ts'] },
})

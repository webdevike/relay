import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { name: 'eva-core', environment: 'node', include: ['src/**/*.test.ts'] },
})

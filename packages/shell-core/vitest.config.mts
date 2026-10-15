import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { name: 'shell-core', environment: 'node', include: ['src/**/*.test.ts'] },
})

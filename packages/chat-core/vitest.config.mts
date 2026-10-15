import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { name: 'chat-core', environment: 'node', include: ['src/**/*.test.ts'] },
})

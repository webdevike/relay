import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  workers: 1,
  timeout: 60_000,
  retries: 0,
  use: { trace: 'retain-on-failure' },
  outputDir: 'test-results',
})

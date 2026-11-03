import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  testIgnore: process.env.EVAOS_PACKAGED === '1' ? undefined : ['**/packaged.spec.ts'],
  workers: 1,
  timeout: 60_000,
  retries: 0,
  use: { trace: 'retain-on-failure' },
  outputDir: 'test-results',
})

import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const exclude = ['e2e/**/*.spec.ts', 'out/**', '**/node_modules/**']
// One Yjs for the app and @relay/canvas-live, as in electron.vite.config.ts.
const YJS = ['yjs', 'y-protocols', 'lib0']

export default defineConfig({
  test: {
    projects: [
      // The desktop gate and lint scripts live at the repo root (scripts/).
      {
        test: {
          name: 'scripts',
          root: '../..',
          environment: 'node',
          include: ['scripts/**/*.test.ts'],
        },
      },
      {
        resolve: { dedupe: YJS },
        test: {
          name: 'main',
          environment: 'node',
          include: ['src/main/**/*.test.ts', 'e2e/helpers/**/*.test.ts'],
          exclude,
        },
      },
      {
        test: {
          name: 'preload',
          environment: 'node',
          include: ['src/preload/**/*.test.ts'],
          exclude,
        },
      },
      {
        plugins: [react()],
        resolve: { dedupe: YJS },
        define: {
          __RELAY_BUILD__: JSON.stringify('test-build'),
          __RELAY_BUILT_AT__: JSON.stringify('2026-11-03T15:04:00.000Z'),
        },
        test: {
          name: 'renderer',
          // Style tests read tokens.css and motion.css through ?raw; do not blank CSS.
          css: { include: [/\.css(\?.*)?$/] },
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          exclude,
          setupFiles: ['./src/renderer/test-setup.ts'],
        },
      },
    ],
  },
})

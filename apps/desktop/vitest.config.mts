import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const exclude = ['e2e/**/*.spec.ts', 'out/**', '**/node_modules/**']

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
        define: { __RELAY_BUILD__: JSON.stringify('test-build') },
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

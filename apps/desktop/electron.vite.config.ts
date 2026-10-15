import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// The built app keeps the strict CSP from index.html; only the dev server relaxes it for HMR.
const devCsp = {
  name: 'eva-dev-csp',
  transformIndexHtml: {
    order: 'pre' as const,
    handler(html: string, ctx: { server?: unknown }) {
      if (!ctx.server) return html
      return html
        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline' http://localhost:*")
        .replace("connect-src 'self'", "connect-src 'self' ws://localhost:* http://localhost:*")
    },
  },
}

export default defineConfig({
  main: { build: { rollupOptions: { input: { index: 'src/main/index.ts' } } } },
  preload: { build: { rollupOptions: { input: { index: 'src/preload/index.ts' } } } },
  renderer: {
    root: 'src/renderer',
    plugins: [react(), devCsp],
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
  },
})

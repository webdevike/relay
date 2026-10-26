import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { searchForWorkspaceRoot } from 'vite'
import type { ViteDevServer } from 'vite'

// Shown in the footer so Isaac can tell which build is running: when this build started.
const buildStamp = `built ${new Date().toLocaleString('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})}`

// HMR reloads the renderer only. Main and preload code load once at launch, so an edit there
// leaves the running app stale until the dev command restarts; tell the footer when that happens.
const staleSignal = {
  name: 'relay-stale-signal',
  configureServer(server: ViteDevServer) {
    const dirs = [resolve(__dirname, 'src/main'), resolve(__dirname, 'src/preload')]
    let stale = false
    server.watcher.add(dirs)
    const mark = (file: string) => {
      if (stale || !dirs.some((d) => file.startsWith(d)) || file.endsWith('.test.ts')) return
      stale = true
      server.ws.send({ type: 'custom', event: 'relay:stale' })
    }
    server.watcher.on('change', mark)
    server.watcher.on('add', mark)
    server.ws.on('connection', () => {
      if (stale) server.ws.send({ type: 'custom', event: 'relay:stale' })
    })
  },
}

// @relay/widget-runtime is linked from the Relay checkout, outside this workspace: the dev server
// may serve its files (theme, theme-components.css) only when allowed by real path.
const widgetRuntime = realpathSync(resolve(__dirname, 'node_modules/@relay/widget-runtime'))

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
  main: {
    build: {
      rollupOptions: {
        input: { index: 'src/main/index.ts', 'test-bench': 'src/main/test-bench/cli.ts' },
      },
    },
  },
  // A sandboxed preload cannot require node_modules, so the browser-action element injector is bundled in.
  preload: {
    build: {
      externalizeDeps: { exclude: ['electron-chrome-extensions'] },
      rollupOptions: { input: { index: 'src/preload/index.ts' } },
    },
  },
  renderer: {
    root: 'src/renderer',
    define: { __RELAY_BUILD__: JSON.stringify(buildStamp) },
    plugins: [react(), devCsp, staleSignal],
    server: { fs: { allow: [searchForWorkspaceRoot(__dirname), widgetRuntime] } },
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
  },
})

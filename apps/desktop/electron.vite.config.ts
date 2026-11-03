import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
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
      rollupOptions: { input: { index: 'src/main/index.ts' } },
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
    define: {
      __RELAY_BUILD__: JSON.stringify(buildStamp),
      __RELAY_BUILT_AT__: JSON.stringify(new Date().toISOString()),
    },
    plugins: [react(), devCsp, staleSignal],
    server: {
      // This app's workspace (apps/desktop/pnpm-workspace.yaml) is nested in the monorepo: allow the
      // monorepo root for its packages, @relay/widget-runtime, @relay/portrait-motion and the DiceBear
      // styles the motion source imports from the root node_modules.
      fs: { allow: [resolve(__dirname, '../..')] },
    },
    // One copy of DiceBear: the still portraits (ui/portrait.ts) and the motion rigs share it.
    resolve: { dedupe: ['@dicebear/core', '@dicebear/micah', '@dicebear/notionists'] },
    build: { rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') } },
  },
})

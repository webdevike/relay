import { defineConfig } from '@playwright/test'

/**
 * Parallel e2e. Every test launches its own Electron with its own EVAOS_CONFIG_DIR (a per-worker
 * mkdtemp, e2e/fixtures.ts), its own copy of any Eva root it writes (e2e/helpers/eva-fixture.ts),
 * ephemeral loopback ports (static server, fake relay host, control server: all listen on port 0)
 * and no CDP port (env.ts gives none in tests), so files do not share state and run side by side.
 * Every launch keeps EVAOS_E2E=1 (buildLaunchEnv): background accessory app, hidden window, no
 * focus stealing, however many run at once.
 *
 * E2E_WORKERS overrides the worker count (default 4; E2E_WORKERS=1 is the old serial run).
 *
 * Files in SERIAL_SPECS run in the `serial` project: one worker, with the machine to themselves,
 * because they assert on wall-clock behaviour (frame-time percentiles, animation timing,
 * filesystem watcher latency) that CPU contention from sibling Electron processes turns into
 * flakes. scripts/e2e.mjs (`pnpm e2e:run`) runs `parallel` then `serial` and reports both, so a
 * failure in the first never hides the second (a project `dependencies` link would skip it).
 */
const workers = Number(process.env['E2E_WORKERS'] ?? 4)
if (!Number.isInteger(workers) || workers < 1) {
  throw new Error(`E2E_WORKERS must be a positive integer, got ${process.env['E2E_WORKERS']}`)
}

const SERIAL_SPECS = [
  // Frame-time p95 and pinned-gap budgets while streaming 5,000 messages.
  '**/chat-bench.spec.ts',
  // Entrance and scroll animations asserted by timing (150ms fades, 2s budgets).
  '**/motion.spec.ts',
  '**/assistant-motion.spec.ts',
  // File watcher and repaint latency under a 1.5s budget.
  '**/chat-watch.spec.ts',
  // Streaming visuals sampled frame by frame.
  '**/chat-visual.spec.ts',
  // Real pointer drags of the dock sashes and the compare slider: mouse events delayed by CPU
  // contention leave the layout a few pixels off (both failed in the first four-worker run).
  // shell-frame 'widths survive a relaunch' also flakes about 1 run in 8 on one worker (the
  // relaunched dock lays out ~16px off the saved width): a product-or-spec bug to chase, not load.
  '**/shell-frame.spec.ts',
  '**/chat-rich.spec.ts',
  // Needs the composer to hold real focus after a reply action; with several Electron apps
  // starting at once the hidden window comes up 'inactive'.
  '**/shared-session.spec.ts',
  // A real popup that must open within 5 s of a guest click; popups queue behind sibling launches.
  '**/browser-auth.spec.ts',
]

// packaged.spec.ts launches the built .app: opt in with EVAOS_PACKAGED=1, never in the project runs.
const packaged = process.env.EVAOS_PACKAGED === '1' ? [] : ['**/packaged.spec.ts']

export default defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.ts',
  workers,
  timeout: 60_000,
  retries: 0,
  use: { trace: 'retain-on-failure' },
  outputDir: 'test-results',
  projects: [
    {
      name: 'parallel',
      testIgnore: [...SERIAL_SPECS, ...packaged],
      fullyParallel: true,
    },
    {
      name: 'serial',
      testMatch: SERIAL_SPECS,
      testIgnore: packaged,
      workers: 1,
    },
  ],
})

import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect"
import type { BunServices } from "@effect/platform-bun/BunServices"
import { chromium } from "playwright-core"
import { pack } from "../../../src/core/Adapter.ts"
import type { ToolsError } from "../../../src/core/Component.ts"

export class BrowserError extends Schema.TaggedError<BrowserError>()("BrowserError", {
  message: Schema.String
}) {}

export interface Shot {
  readonly viewport: number
  readonly file: string
}

export interface Capture {
  readonly url: string
  readonly title: string
  readonly shots: ReadonlyArray<Shot>
}

/** A full-page shot stops here: past it a vision model downscales the page until text is unreadable. */
export const MAX_HEIGHT = 2400
const WINDOW_HEIGHT = 900
const PHONE = 480

/**
 * Its own headless Chromium (Playwright's headless shell), launched per capture and closed after: no
 * window, never focus, never Isaac's browsers or the live Relay app (no CDP attach). http(s) and file URLs only.
 */
export class Browser extends Context.Service<Browser, {
  capture(url: string, viewports: ReadonlyArray<number>, dir: string): Effect.Effect<Capture, BrowserError>
}>()("atomic-agents/browser/Browser") {
  static readonly layer = Layer.succeed(Browser, Browser.of({
    capture: (url, viewports, dir) =>
      Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => chromium.launch({ headless: true }),
          catch: (error) => new BrowserError({ message: `launch headless Chromium: ${String(error)}` })
        }),
        (browser) =>
          Effect.tryPromise({
            try: async (): Promise<Capture> => {
              const shots: Array<Shot> = []
              let title = ""
              let landed = url
              for (const viewport of viewports) {
                const phone = viewport <= PHONE
                const context = await browser.newContext({
                  viewport: { width: viewport, height: WINDOW_HEIGHT },
                  deviceScaleFactor: phone ? 2 : 1,
                  isMobile: phone,
                  hasTouch: phone
                })
                try {
                  const page = await context.newPage()
                  const response = await page.goto(url, { waitUntil: "load", timeout: 30_000 })
                  if (response !== null && response.status() >= 400) throw new Error(`${url} answered ${response.status()}`)
                  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined)
                  // Scroll the shot's height once: content that reveals on scroll (IntersectionObserver) appears, lazy images load.
                  const reach = Math.min(await page.evaluate(() => document.documentElement.scrollHeight), MAX_HEIGHT)
                  for (let y = 0; y < reach; y += Math.round(WINDOW_HEIGHT * 0.75)) {
                    await page.evaluate((top) => window.scrollTo(0, top), y)
                    await page.waitForTimeout(150)
                  }
                  await page.evaluate(() => window.scrollTo(0, 0))
                  await page.waitForTimeout(300)
                  await page.evaluate(() => document.fonts.ready.then(() => undefined))
                  const height = await page.evaluate(() => document.documentElement.scrollHeight)
                  const file = `${dir}/shot-${viewport}.png`
                  await page.screenshot({
                    path: file,
                    fullPage: true,
                    clip: { x: 0, y: 0, width: viewport, height: Math.min(Math.max(height, WINDOW_HEIGHT), MAX_HEIGHT) },
                    animations: "disabled"
                  })
                  title = await page.title()
                  landed = page.url()
                  shots.push({ viewport, file })
                } finally {
                  await context.close()
                }
              }
              return { url: landed, title, shots }
            },
            catch: (error) => new BrowserError({ message: error instanceof Error ? error.message : String(error) })
          }),
        (browser) => Effect.promise(() => browser.close().catch(() => undefined))
      ).pipe(
        Effect.timeoutOrElse({ duration: "2 minutes", orElse: () => Effect.fail(new BrowserError({ message: `capture ${url} timed out` })) })
      )
  }))
}

const Input = Schema.Struct({
  url: Schema.optionalKey(Schema.String),
  screenshot: Schema.optionalKey(Schema.String),
  viewports: Schema.optionalKey(Schema.Array(Schema.Int))
})
const decodeInput = Schema.decodeUnknownEffect(Input)

/** Desktop width when the request names none. */
export const DEFAULT_VIEWPORTS: ReadonlyArray<number> = [1280]

/** The browser adapters over `layer` (headless Chromium, or a test fake). */
export const browserPack = (layer: Layer.Layer<Browser, ToolsError, BunServices> = Browser.layer) =>
  pack({
    name: "browser",
    layer,
    sources: [{
      name: "browser.screenshot",
      description:
        "Input url (http, https or file) or screenshot (a PNG path), plus viewports (widths, default 1280). A url is opened in a private headless Chromium at each width and shot full page (cut at 2400px tall; phone widths at 2x); a screenshot is used as is. Provides screenshots (paths in the run dir), viewports and page (one line saying what was shot).",
      provides: ["screenshots", "viewports", "page"],
      summary: [],
      fetch: (raw, run) =>
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const input = yield* decodeInput(raw).pipe(Effect.mapError((error) => new BrowserError({ message: `input: ${error.message}` })))
          const one = (fields: Readonly<Record<string, unknown>>) => ({ items: [{ fields, commit: Effect.void }], done: Effect.void, summary: {} })
          if ((input.url === undefined) === (input.screenshot === undefined)) {
            return yield* new BrowserError({ message: "give exactly one of url or screenshot" })
          }
          if (input.screenshot !== undefined) {
            const file = path.resolve(input.screenshot)
            if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) return yield* new BrowserError({ message: `screenshot ${file} does not exist` })
            const viewports = input.viewports ?? []
            return one({
              screenshots: [file],
              viewports,
              page: `A screenshot (${path.basename(file)})${viewports.length > 0 ? ` taken ${viewports.join(" and ")}px wide` : ""}.`
            })
          }
          const url = input.url!
          if (!/^(https?|file):/.test(url)) return yield* new BrowserError({ message: `url ${url}: only http, https and file URLs` })
          const viewports = input.viewports !== undefined && input.viewports.length > 0 ? input.viewports : DEFAULT_VIEWPORTS
          if (viewports.some((width) => width < 240 || width > 3840)) return yield* new BrowserError({ message: `viewports ${viewports.join(",")}: widths between 240 and 3840` })
          const capture = yield* (yield* Browser).capture(url, viewports, run.runDir)
          return one({
            screenshots: capture.shots.map((shot) => shot.file),
            viewports,
            page: `${capture.url}${capture.title === "" ? "" : ` ("${capture.title}")`}, shot full page at ${viewports.map((width) => `${width}px`).join(" and ")} wide (one image per width, in that order; cut at ${MAX_HEIGHT}px tall).`
          })
        })
    }]
  })

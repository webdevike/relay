import { Context, Effect, Layer, Schema } from "effect";
import { chromium } from "playwright-core";
import type { Theme } from "../schema.ts";
import { type Found, inkShare, type Limits, measure, mount } from "./page.ts";

export class RenderError extends Schema.TaggedError<RenderError>()("RenderError", {
  message: Schema.String,
}) {}

/** Where the render check draws the line (the agent's instructions quote these). */
export const LIMITS: Limits = {
  minFont: 7,
  minContrast: 3,
  decorativeAlpha: 0.2,
  minWidth: 480,
  maxWidth: 1920,
  minHeight: 240,
  maxHeight: 1920,
  minTexts: 3,
  overlap: 0.15,
  slack: 2,
};

/** PNG pixels per viewBox unit. */
export const SCALE = 2;
/** Share of pixels that must differ from the background, else the render is blank. */
const MIN_INK = 0.01;

/** The three families of the design system; the page links them and the standalone SVG imports them. */
export const FONTS =
  "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap";

export const PAPER: Readonly<Record<Theme, string>> = { dark: "#2d3142", light: "#f5f5f5" };

export interface Rendered {
  /** The viewBox size (0 when it never mounted). */
  readonly width: number;
  readonly height: number;
  /** Written when the SVG mounted. */
  readonly png: string | undefined;
  readonly problems: ReadonlyArray<Found>;
}

/**
 * Renders one SVG the way the diagram is delivered: in its own headless Chromium (Playwright's headless shell,
 * launched per render, no window, never Isaac's browsers), on the theme's paper with the design system's fonts,
 * at its viewBox size, shot at 2x to PNG; and measures it on the way (`page.ts`).
 */
export class Renderer extends Context.Service<
  Renderer,
  {
    render(svg: string, theme: Theme, png: string): Effect.Effect<Rendered, RenderError>;
  }
>()("atomic-agents/diagram/Renderer") {
  static readonly layer = Layer.succeed(
    Renderer,
    Renderer.of({
      render: (svg, theme, png) =>
        Effect.acquireUseRelease(
          Effect.tryPromise({
            try: () => chromium.launch({ headless: true }),
            catch: (error) =>
              new RenderError({ message: `launch headless Chromium: ${String(error)}` }),
          }),
          (browser) =>
            Effect.tryPromise({
              try: async (): Promise<Rendered> => {
                const context = await browser.newContext({
                  viewport: { width: 1280, height: 800 },
                  deviceScaleFactor: SCALE,
                });
                const page = await context.newPage();
                await page
                  .setContent(
                    `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${FONTS.replaceAll("&", "&amp;")}"><style>html,body{margin:0;background:${PAPER[theme]}}svg{display:block}</style></head><body></body></html>`,
                    { waitUntil: "load", timeout: 20_000 },
                  )
                  .catch(() => undefined);
                const mounted = await page.evaluate(mount, { svg, limits: LIMITS });
                if (!mounted.ok)
                  return { width: 0, height: 0, png: undefined, problems: mounted.problems };
                await page.setViewportSize({
                  width: Math.ceil(mounted.width),
                  height: Math.ceil(mounted.height),
                });
                await page
                  .waitForLoadState("networkidle", { timeout: 10_000 })
                  .catch(() => undefined);
                await page.evaluate(() => document.fonts.ready.then(() => undefined));
                const problems = [
                  ...(await page.evaluate(measure, { limits: LIMITS, paper: PAPER[theme] })),
                ];
                const shot = await page
                  .locator("body > svg")
                  .screenshot({ path: png, animations: "disabled" });
                const ink = await page.evaluate(
                  inkShare,
                  `data:image/png;base64,${shot.toString("base64")}`,
                );
                if (ink < MIN_INK)
                  problems.push({
                    fatal: true,
                    message: `the render is blank: ${(ink * 100).toFixed(1)}% of it differs from the background`,
                  });
                return { width: mounted.width, height: mounted.height, png, problems };
              },
              catch: (error) =>
                new RenderError({
                  message: error instanceof Error ? error.message : String(error),
                }),
            }),
          (browser) => Effect.promise(() => browser.close().catch(() => undefined)),
        ).pipe(
          Effect.timeoutOrElse({
            duration: "2 minutes",
            orElse: () => Effect.fail(new RenderError({ message: "render timed out" })),
          }),
        ),
    }),
  );
}

import { fromCallback, fromPromise } from "xstate"
import { askMachine, MuseFailure } from "./ask.machine.ts"
import { type Cua, failed, textOf } from "./cua.ts"
import { type Element, rateLimited, readScreen } from "./screen.ts"

/**
 * The actors of `askMachine` over cua-driver, driving Meta's Muse desktop app in the background: no
 * activation, no window in Isaac's face. What it does to Muse, and nothing else: launch it in the
 * background if it is not running, unhide it (NSRunningApplication, no activation) and park its window
 * so only a few pixels show in the screen's bottom-right corner, press "New side chat", type the
 * question with keyboard events sent to Muse's process (its composer is not in the accessibility tree
 * but has keyboard focus in a new chat), press Return once, then only read. The whole flow is
 * read-only toward everyone else: it never presses a message's buttons, links, cards or menus.
 */

const BUNDLE = "com.meta.endo"
/** How much of the parked window stays on screen (macOS keeps part of a window on its display). */
const PARK_VISIBLE = { x: 8, y: 32 }
const TYPE_DELAY_MS = 40

interface Window {
  readonly app_name?: string
  readonly title?: string
  readonly pid: number
  readonly window_id: number
  readonly is_on_screen?: boolean
  readonly bounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
}

interface App {
  readonly bundle_id?: string
  readonly pid?: number
  readonly running?: boolean
  readonly active?: boolean
}

/** What the driver needs from macOS beyond cua-driver; a fake in tests. */
export interface Host {
  /** Unhide Muse without activating it. */
  unhide(): Promise<void>
  /** Bring back the app that was in front (after a launch that activated Muse). */
  activate(bundleId: string): Promise<void>
  sleep(ms: number): Promise<void>
  now(): number
}

const jxa = async (script: string) => {
  const proc = Bun.spawn(["osascript", "-l", "JavaScript", "-e", `ObjC.import("AppKit"); ${script}`], { stdout: "ignore", stderr: "pipe" })
  if ((await proc.exited) !== 0) throw new Error(`osascript: ${(await new Response(proc.stderr).text()).trim().slice(0, 200)}`)
}

/** NSRunningApplication calls: unhiding and activating another app need no Accessibility grant. */
export const macHost: Host = {
  unhide: () => jxa(`const a = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("${BUNDLE}"); if (a.count > 0) a.objectAtIndex(0).unhide`),
  activate: (bundleId) =>
    jxa(`const a = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(${JSON.stringify(bundleId)}); if (a.count > 0) a.objectAtIndex(0).activateWithOptions(0)`),
  sleep: (ms) => Bun.sleep(ms),
  now: () => Date.now()
}

export interface DriverOptions {
  /** Between window reads while waiting on Muse. */
  readonly pollMs: number
  /** Longest wait for Muse to launch and draw its chat UI. */
  readonly loadMs: number
}

export const DEFAULTS: DriverOptions = { pollMs: 2_500, loadMs: 45_000 }

/** `askMachine` with its actors bound to one cua-driver connection. */
export const museAsk = (cua: Cua, host: Host = macHost, options: DriverOptions = DEFAULTS) => {
  let window: Window | undefined

  const call = async (name: string, args: Readonly<Record<string, unknown>>, kind: "unavailable" | "ui_changed" = "ui_changed") => {
    const reply = await cua.call(name, args)
    if (failed(reply)) throw new MuseFailure(kind, `cua-driver ${name}: ${textOf(reply).slice(0, 300)}`)
    return reply.result?.structuredContent ?? {}
  }
  const museApp = async () => ((await call("list_apps", {}, "unavailable"))["apps"] as ReadonlyArray<App> | undefined ?? []).find((app) => app.bundle_id === BUNDLE)
  const museWindows = async () =>
    ((await call("list_windows", {}, "unavailable"))["windows"] as ReadonlyArray<Window> | undefined ?? []).filter((candidate) => candidate.app_name === "Muse")
  const snapshot = async () => {
    if (window === undefined) throw new MuseFailure("unavailable", "no Muse window")
    const state = await call("get_window_state", { pid: window.pid, window_id: window.window_id, include_screenshot: false, timeout_ms: 8_000, max_elements: 6_000 })
    return state as { elements?: ReadonlyArray<Element>; background_input?: { routes?: ReadonlyArray<{ route: string; status: string; reason?: string }> } }
  }

  const attach = async () => {
    const before = await museApp()
    let launchedOver: string | undefined
    if (before?.running !== true) {
      const front = ((await call("list_apps", {}, "unavailable"))["apps"] as ReadonlyArray<App> | undefined ?? []).find((app) => app.active === true)
      launchedOver = front?.bundle_id
      await call("launch_app", { bundle_id: BUNDLE }, "unavailable")
    } else if (before.active === true) {
      throw new MuseFailure("busy", "Muse is the app in front (Isaac is using it); not driving it from behind him")
    }
    // The chat window is titled "Muse"; a signed-out Muse shows only its "Log in" window.
    const deadline = host.now() + options.loadMs
    let found: Window | undefined
    for (;;) {
      const windows = await museWindows()
      found = windows.find((candidate) => candidate.title === "Muse")
      if (found !== undefined) break
      if (windows.some((candidate) => candidate.title === "Log in" && candidate.is_on_screen === true)) {
        throw new MuseFailure("signed_out", "Muse is signed out: Isaac needs to open Muse and log in to Meta")
      }
      if (host.now() > deadline) throw new MuseFailure("unavailable", "Muse did not open a chat window")
      await host.sleep(options.pollMs)
    }
    window = found
    if (launchedOver !== undefined && (await museApp())?.active === true) await host.activate(launchedOver)
    // A hidden app takes no keyboard input; unhiding does not activate it.
    const routes = (await snapshot()).background_input?.routes ?? []
    if (routes.some((route) => route.reason === "minimized_or_hidden_window")) {
      await host.unhide()
      await host.sleep(500)
    }
    const screen = (await call("get_screen_size", {}, "unavailable")) as { width?: number; height?: number }
    if (screen.width !== undefined && screen.height !== undefined && found.bounds !== undefined) {
      const park = { x: screen.width - PARK_VISIBLE.x, y: screen.height - PARK_VISIBLE.y }
      const current = (await museWindows()).find((candidate) => candidate.window_id === found.window_id)?.bounds
      if (current?.x !== park.x || current.y !== park.y) {
        await call("set_window_frame", { pid: found.pid, window_id: found.window_id, x: park.x, y: park.y, width: found.bounds.width, height: found.bounds.height })
      }
    }
    // The web view fills its tree lazily after launch.
    for (;;) {
      const elements = (await snapshot()).elements ?? []
      if (readScreen(elements).newChat !== undefined) return
      if (elements.some((element) => /^(Log in|Continue with|Sign in)/i.test(element.label ?? element.value ?? ""))) {
        throw new MuseFailure("signed_out", "Muse shows its login screen: Isaac needs to log in to Meta in Muse")
      }
      if (host.now() > deadline) throw new MuseFailure("ui_changed", "Muse's chat UI has no \"New side chat\" button (the app changed or is still loading)")
      await host.sleep(options.pollMs)
    }
  }

  const openChat = async () => {
    const button = readScreen((await snapshot()).elements ?? []).newChat
    if (button?.element_token === undefined) throw new MuseFailure("ui_changed", "the \"New side chat\" button went away")
    await call("click", { pid: window?.pid, element_token: button.element_token })
    for (let tries = 0; tries < 8; tries++) {
      await host.sleep(1_000)
      const screen = readScreen((await snapshot()).elements ?? [])
      if (screen.composer && screen.sent.length === 0) return
    }
    throw new MuseFailure("ui_changed", "a new side chat did not open empty with a composer")
  }

  const typePrompt = async (prompt: string) => {
    // Return in the composer sends: the prompt is one line.
    const text = prompt.replace(/\s+/g, " ").trim()
    if (window === undefined) throw new MuseFailure("unavailable", "no Muse window")
    if ((await museApp())?.active === true) throw new MuseFailure("busy", "Muse came to the front; not typing while Isaac may be in it")
    await call("type_text", { pid: window.pid, window_id: window.window_id, text, delay_ms: TYPE_DELAY_MS })
  }

  const send = async () => {
    if (window === undefined) throw new MuseFailure("unavailable", "no Muse window")
    await host.sleep(800)
    await call("press_key", { pid: window.pid, window_id: window.window_id, key: "return" })
  }

  return askMachine.provide({
    actors: {
      attach: fromPromise(attach),
      openChat: fromPromise(openChat),
      typePrompt: fromPromise(({ input }) => typePrompt(input.prompt)),
      send: fromPromise(send),
      watch: fromCallback(({ sendBack }) => {
        let stopped = false
        void (async () => {
          while (!stopped) {
            await host.sleep(options.pollMs)
            if (stopped) return
            // A failed read is skipped: the machine's timeouts decide when waiting is over.
            const elements = await snapshot().then((state) => state.elements ?? [], () => undefined)
            if (elements === undefined || stopped) continue
            const screen = readScreen(elements)
            sendBack({
              type: "muse.progress",
              progress: { posted: screen.sent.length > 0, working: screen.working, rateLimited: screen.reply !== undefined && rateLimited(screen.reply.text), reply: screen.reply }
            })
          }
        })()
        return () => {
          stopped = true
        }
      })
    }
  })
}

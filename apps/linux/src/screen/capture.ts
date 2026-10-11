// Live view on macOS: drives the `relay-screen` ScreenCaptureKit helper that ships inside
// "Relay Host.app" next to the compiled daemon (Screen Recording permission belongs to the app).
// `list` is one short run; `watch` keeps one helper per watcher alive, reads length-prefixed JPEGs
// from its stdout, and ends it by closing stdin (or SIGTERM), so no viewer means no capture.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { ScreenWindow, type ScreenError } from "@relay/protocol";
import { z } from "zod";
import type { ScreenCapture, ScreenFrame, ScreenWatch } from "../seams";

const FPS = 10;
/** iPhone Pro Max portrait width in pixels; frames never go wider. */
const MAX_WIDTH = 1170;
const HEADER = 12;

/** Exit codes from RelayScreen.swift. */
function errorFor(code: number | null): ScreenError {
  if (code === 2) return "denied";
  if (code === 3) return "gone";
  return "failed";
}

/** `$RELAY_SCREEN_HELPER`, else `relay-screen` beside the running executable (the app bundle). */
export function findScreenHelper(): string | null {
  if (process.platform !== "darwin") return null;
  const override = process.env["RELAY_SCREEN_HELPER"];
  if (override !== undefined && override !== "") return existsSync(override) ? override : null;
  const bundled = join(dirname(process.execPath), "relay-screen");
  return existsSync(bundled) ? bundled : null;
}

/** Stands in on hosts without the helper: every request reports `unavailable`. */
export const NO_SCREEN: ScreenCapture = {
  list: () => Promise.resolve({ windows: [], error: "unavailable" }),
  watch: (_windowId, _onFrame, onEnd) => {
    queueMicrotask(() => {
      onEnd("unavailable");
    });
    return { stop: () => undefined };
  },
};

export class HelperScreenCapture implements ScreenCapture {
  constructor(
    private readonly helper: string,
    private readonly log: (line: string) => void,
  ) {}

  async list(): Promise<{ windows: ScreenWindow[]; error?: ScreenError }> {
    const child = Bun.spawn([this.helper, "list"], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) {
      this.log(`screen: list failed (${code}): ${err.trim()}`);
      return { windows: [], error: errorFor(code) };
    }
    const parsed = z.array(ScreenWindow).safeParse(JSON.parse(out));
    if (!parsed.success) {
      this.log(`screen: list returned an unexpected shape: ${parsed.error.message}`);
      return { windows: [], error: "failed" };
    }
    return { windows: parsed.data };
  }

  watch(windowId: number, onFrame: (frame: ScreenFrame) => void, onEnd: (error: ScreenError) => void): ScreenWatch {
    // An object, not a `let`: the frame loop reads it after `stop`/exit flip it from other closures.
    const ended = { stopped: false };
    const child = Bun.spawn([this.helper, "watch", String(windowId), String(FPS), String(MAX_WIDTH)], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    void (async () => {
      let pending: Uint8Array = new Uint8Array(0);
      for await (const chunk of child.stdout) {
        pending = pending.length === 0 ? chunk : concat(pending, chunk);
        while (pending.length >= HEADER) {
          const view = new DataView(pending.buffer, pending.byteOffset, HEADER);
          const length = view.getUint32(0);
          if (pending.length < HEADER + length) break;
          const frame: ScreenFrame = {
            width: view.getUint32(4),
            height: view.getUint32(8),
            jpeg: pending.slice(HEADER, HEADER + length),
          };
          pending = pending.subarray(HEADER + length);
          if (!ended.stopped) onFrame(frame);
        }
      }
    })();
    void Promise.all([child.exited, new Response(child.stderr).text()]).then(([code, err]) => {
      if (ended.stopped) return;
      ended.stopped = true;
      this.log(`screen: watch ${windowId} ended (${code}): ${err.trim()}`);
      onEnd(errorFor(code));
    });
    return {
      stop: () => {
        if (ended.stopped) return;
        ended.stopped = true;
        void child.stdin.end();
        child.kill();
      },
    };
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, RenderFailure } from "@relay/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { isBackgroundLine } from "../src/agents/ask-hold";
import {
  defaultRenderFailuresPath,
  RENDER_STALE_MS,
  RenderFailureService,
  renderFailureLine,
  type RenderFailureDeps,
  type RenderFailureLine,
} from "../src/render-failures/service";
import type { SessionClock } from "../src/session";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class FakeClock implements SessionClock {
  t = 10_000_000;
  private timers: { at: number; fn: () => void; live: boolean }[] = [];
  now(): number {
    return this.t;
  }
  after(ms: number, fn: () => void): () => void {
    const timer = { at: this.t + ms, fn, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  }
  advance(ms: number): void {
    this.t += ms;
    const due = this.timers.filter((timer) => timer.live && timer.at <= this.t);
    this.timers = this.timers.filter((timer) => !due.includes(timer));
    for (const timer of due) timer.fn();
  }
}

/** Lets the async send (already-settled fakes) and the log append after it run: a few microtask turns, no real time. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

interface Rig {
  readonly service: RenderFailureService;
  readonly clock: FakeClock;
  readonly path: string;
  readonly said: [string, string][];
  readonly replied: [string, string][];
  readonly lines: () => RenderFailureLine[];
  readonly make: () => RenderFailureService;
}

function rig(options: { sessions?: AgentSession[]; clock?: FakeClock; path?: string; failSay?: boolean } = {}): Rig {
  const path = options.path ?? join(mkdtempSync(join(tmpdir(), "relay-render-")), "relay", "render-failures.jsonl");
  if (options.path === undefined) dirs.push(join(path, "..", ".."));
  const clock = options.clock ?? new FakeClock();
  const said: [string, string][] = [];
  const replied: [string, string][] = [];
  const deps: RenderFailureDeps = {
    path,
    assistant: (id) =>
      id === "astra" || id === "golf"
        ? {
            say: (text) => {
              if (options.failSay === true) return Promise.reject(new Error("launch failed"));
              said.push([id, text]);
              return Promise.resolve();
            },
          }
        : undefined,
    sessions: () => options.sessions ?? [],
    reply: (sessionId, text) => {
      replied.push([sessionId, text]);
      return Promise.resolve();
    },
    clock,
    log: () => undefined,
  };
  const make = (): RenderFailureService => new RenderFailureService(deps);
  const lines = (): RenderFailureLine[] =>
    existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as RenderFailureLine)
      : [];
  return { service: make(), clock, path, said, replied, lines, make };
}

const phone = { id: "phone-1", name: "Isaac's iPhone" };
const desk = { id: "relay-desktop", name: "Mac Mini" };

function failure(over: Partial<RenderFailure> = {}): RenderFailure {
  return {
    thread: "assistant:astra",
    message: `assistant@${String(10_000_000 - 60_000)}`,
    kind: "model",
    form: "markdown",
    src: "/drops/abc/tok",
    error: "served model/gltf-binary: markdown can't show a 3D model",
    surface: "phone",
    ...over,
  };
}

describe("renderFailureLine", () => {
  it("lists every failure of the bubble in one paragraph and adds the stop line when it is the last allowed", () => {
    const a = failure();
    const b = failure({ kind: "video", form: "openui", src: "https://x.test/a.webm", error: "video error: MEDIA_ERR_SRC_NOT_SUPPORTED", surface: "desktop" });
    const text = renderFailureLine("assistant@5", [a, b], false);
    expect(text).toBe(
      "Render failed on phone and desktop: model (markdown) /drops/abc/tok (served model/gltf-binary: markdown can't show a 3D model); " +
        "video (openui) https://x.test/a.webm (video error: MEDIA_ERR_SRC_NOT_SUPPORTED) in your message assistant@5. " +
        'Repost it in a working form: a .glb/.gltf only renders in an openui Model("/drops/<id>/<token>") block, images, video and audio as the markdown that share prints, ' +
        "https or /drops srcs only, never local paths (skill://relay-widgets). Reply (nothing to report) if it was already fixed.",
    );
    expect(text).not.toContain("\n");
    expect(renderFailureLine("assistant@5", [a], true)).toMatch(
      / Further render failures in this thread are only logged for 30 minutes; if the repost fails too, tell Isaac instead of retrying\.$/,
    );
  });

  it("lives at $XDG_CONFIG_HOME/relay/render-failures.jsonl", () => {
    const before = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = "/tmp/cfg";
    try {
      expect(defaultRenderFailuresPath()).toBe("/tmp/cfg/relay/render-failures.jsonl");
    } finally {
      if (before === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = before;
    }
  });
});

describe("RenderFailureService", () => {
  it("batches every failing src of a bubble into one line after the debounce, logging each report once", async () => {
    const r = rig();
    r.service.report(failure(), phone);
    r.service.report(failure({ src: "/drops/def/tok2", kind: "image", error: "image failed to load" }), phone);
    r.service.report(failure(), phone); // same thread|message|src|surface: dropped
    r.service.report(failure({ surface: "desktop" }), desk);
    r.clock.advance(1999);
    await settle();
    expect(r.said).toEqual([]);
    r.clock.advance(1);
    await settle();
    expect(r.said).toHaveLength(1);
    const [agent, text] = r.said[0] ?? ["", ""];
    expect(agent).toBe("astra");
    expect(text).toContain("Render failed on phone and desktop: model (markdown) /drops/abc/tok");
    expect(text).toContain("image (markdown) /drops/def/tok2 (image failed to load)");
    expect(text).not.toContain("Further render failures");
    const lines = r.lines();
    expect(lines.map((line) => [line.src, line.surface, line.delivered])).toEqual([
      ["/drops/abc/tok", "phone", "sent"],
      ["/drops/def/tok2", "phone", "batched"],
      ["/drops/abc/tok", "desktop", "batched"],
    ]);
    expect(lines[0]).toMatchObject({ thread: "assistant:astra", agent: "astra", kind: "model", form: "markdown", device: phone, at: new Date(r.clock.t - 2000).toISOString() });
  });

  it("tells each bubble at most once: later reports are only logged as duplicate-message", async () => {
    const r = rig();
    r.service.report(failure(), phone);
    r.clock.advance(2000);
    await settle();
    r.service.report(failure({ surface: "desktop" }), desk);
    r.service.report(failure({ src: "/drops/zzz/tok" }), phone);
    r.clock.advance(5000);
    await settle();
    expect(r.said).toHaveLength(1);
    expect(r.lines().map((line) => line.delivered)).toEqual(["sent", "duplicate-message", "duplicate-message"]);
  });

  it("reloads the log on start: no re-logging a known report, no second line for a told bubble", async () => {
    const r = rig();
    r.service.report(failure(), phone);
    r.clock.advance(2000);
    await settle();
    const restarted = rig({ path: r.path, clock: r.clock });
    restarted.service.report(failure(), phone);
    expect(restarted.lines()).toHaveLength(1);
    restarted.service.report(failure({ surface: "desktop" }), desk);
    restarted.clock.advance(2000);
    await settle();
    expect(restarted.said).toEqual([]);
    expect(restarted.lines().map((line) => line.delivered)).toEqual(["sent", "duplicate-message"]);
  });

  it("caps a thread at 3 lines per 30 minutes, the third saying so, and counts lines from before a restart", async () => {
    const r = rig();
    const send = async (n: number): Promise<void> => {
      r.service.report(failure({ message: `assistant@${String(r.clock.t - 1000 + n)}` }), phone);
      r.clock.advance(2000);
      await settle();
    };
    await send(1);
    await send(2);
    expect(r.said.at(-1)?.[1]).not.toContain("Further render failures");
    await send(3);
    expect(r.said).toHaveLength(3);
    expect(r.said.at(-1)?.[1]).toMatch(/Further render failures in this thread are only logged for 30 minutes; if the repost fails too, tell Isaac instead of retrying\.$/);
    await send(4);
    expect(r.said).toHaveLength(3);
    expect(r.lines().at(-1)?.delivered).toBe("capped");
    // Other threads have their own cap.
    r.service.report(failure({ thread: "assistant:golf", message: `assistant@${String(r.clock.t)}` }), phone);
    r.clock.advance(2000);
    await settle();
    expect(r.said.at(-1)?.[0]).toBe("golf");
    // A restart still knows the window is full.
    const restarted = rig({ path: r.path, clock: r.clock });
    restarted.service.report(failure({ message: `assistant@${String(r.clock.t)}` }), phone);
    restarted.clock.advance(2000);
    await settle();
    expect(restarted.said).toEqual([]);
    expect(restarted.lines().at(-1)?.delivered).toBe("capped");
    // Once the window rolls past the first lines, the thread can hear again.
    restarted.clock.advance(30 * 60_000);
    restarted.service.report(failure({ message: `assistant@${String(restarted.clock.t)}` }), phone);
    restarted.clock.advance(2000);
    await settle();
    expect(restarted.said).toHaveLength(1);
  });

  it("only logs a bubble older than two hours as stale", async () => {
    const r = rig();
    r.service.report(failure({ message: `assistant@${String(r.clock.t - RENDER_STALE_MS - 1)}` }), phone);
    r.clock.advance(5000);
    await settle();
    expect(r.said).toEqual([]);
    expect(r.lines().map((line) => [line.delivered, line.agent])).toEqual([["stale", "astra"]]);
  });

  it("routes a session thread to its assistant, else to the live session as a background line, else logs no-owner", async () => {
    const sessions = [
      { id: "s-astra", kind: "assistant", assistant: "astra", status: "idle" },
      { id: "s-live", kind: "manual", status: "working" },
      { id: "s-dead", kind: "manual", status: "ended" },
    ] as unknown as AgentSession[];
    const r = rig({ sessions });
    const at = `assistant@${String(r.clock.t)}`;
    r.service.report(failure({ thread: "session:s-astra", message: at }), phone);
    r.service.report(failure({ thread: "session:s-live", message: at }), phone);
    r.service.report(failure({ thread: "session:s-dead", message: at }), phone);
    r.service.report(failure({ thread: "session:s-gone", message: at }), phone);
    r.service.report(failure({ thread: "assistant:nobody", message: at }), phone);
    r.clock.advance(2000);
    await settle();
    expect(r.said.map(([agent]) => agent)).toEqual(["astra"]);
    expect(r.replied).toHaveLength(1);
    const [sessionId, text] = r.replied[0] ?? ["", ""];
    expect(sessionId).toBe("s-live");
    expect(text.startsWith("[From Relay's background jobs] Render failed on phone: ")).toBe(true);
    expect(isBackgroundLine(text)).toBe(true);
    // A sent line is appended once its send settles, so after the no-owner ones.
    expect(r.lines().map((line) => [line.thread, line.agent, line.delivered])).toEqual([
      ["session:s-dead", null, "no-owner"],
      ["session:s-gone", null, "no-owner"],
      ["assistant:nobody", "nobody", "no-owner"],
      ["session:s-astra", "astra", "sent"],
      ["session:s-live", null, "sent"],
    ]);
  });

  it("logs no-owner and keeps the bubble untold when the send fails", async () => {
    const r = rig({ failSay: true });
    r.service.report(failure(), phone);
    r.clock.advance(2000);
    await settle();
    expect(r.lines().map((line) => line.delivered)).toEqual(["no-owner"]);
  });
});

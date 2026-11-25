import { describe, expect, it, vi } from "vitest";
import type { DesktopWindow } from "../src/desktop";
import { agentHandler, type AgentDeps } from "../src/agent/server";

const TOKEN = "a".repeat(64);
const win = (hwnd: number, title: string): DesktopWindow => ({
  hwnd,
  title,
  pid: 1,
  process: "x.exe",
  rect: { x: 0, y: 0, width: 10, height: 10 },
  minimized: false,
  foreground: false,
});

function deps(overrides: Partial<AgentDeps> = {}): AgentDeps {
  return {
    token: TOKEN,
    version: "0.1.0",
    run: vi.fn(() => Promise.resolve({ outcome: "exited" as const, exitCode: 0, stdout: "hi\n", stderr: "", truncated: false, durationMs: 5 })),
    checkRun: () => undefined,
    launch: vi.fn(),
    windows: () => [win(10, "Notepad"), win(11, "Solstice (64-bit)"), win(12, "Solstice launcher")],
    focus: (hwnd) => ({ ...win(hwnd, "focused"), foreground: true }),
    shotScreen: () => ({ png: Uint8Array.of(0x89, 0x50), rect: { x: -1920, y: 0, width: 3840, height: 1080 }, black: false }),
    shotWindow: vi.fn(() => ({ png: Uint8Array.of(1), rect: { x: 5, y: 6, width: 7, height: 8 }, black: true })),
    readClipboard: () => Promise.resolve("text"),
    writeClipboard: vi.fn(() => Promise.resolve()),
    log: () => undefined,
    ...overrides,
  };
}

const call = (handler: (r: Request) => Promise<Response>, path: string, init: RequestInit & { token?: string | null } = {}) => {
  const { token = TOKEN, ...rest } = init;
  return handler(
    new Request(`http://127.0.0.1:7818${path}`, {
      ...rest,
      headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...(rest.body === undefined ? {} : { "content-type": "application/json" }) },
    }),
  );
};

describe("agent channel", () => {
  it("refuses a missing or wrong token before running anything", async () => {
    const d = deps();
    const handler = agentHandler(d);
    const body = JSON.stringify({ command: "whoami" });
    expect((await call(handler, "/v1/run", { method: "POST", body, token: null })).status).toBe(401);
    expect((await call(handler, "/v1/run", { method: "POST", body, token: "b".repeat(64) })).status).toBe(401);
    expect((await call(handler, "/v1/run", { method: "POST", body, token: TOKEN.slice(1) })).status).toBe(401);
    expect(d.run).not.toHaveBeenCalled();
  });

  it("runs a command and returns its result", async () => {
    const d = deps();
    const res = await call(agentHandler(d), "/v1/run", { method: "POST", body: JSON.stringify({ command: "'hi'", timeoutMs: 5000 }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "exited", exitCode: 0, stdout: "hi\n" });
    expect(d.run).toHaveBeenCalledWith({ command: "'hi'", timeoutMs: 5000 }, expect.any(AbortSignal));
  });

  it("answers 400 for a bad body or a cwd that is not there", async () => {
    const handler = agentHandler(deps({ checkRun: () => { throw new Error("cwd X:\\nope is not a directory"); } }));
    const empty = await call(handler, "/v1/run", { method: "POST", body: JSON.stringify({ command: "" }) });
    expect(empty.status).toBe(400);
    const cwd = await call(handler, "/v1/run", { method: "POST", body: JSON.stringify({ command: "dir", cwd: "X:\\nope" }) });
    expect(cwd.status).toBe(400);
    expect(await cwd.json()).toEqual({ error: "cwd X:\\nope is not a directory" });
  });

  it("names a window by hwnd or by a title fragment, and refuses an ambiguous fragment", async () => {
    const d = deps();
    const handler = agentHandler(d);
    const focused = (await (await call(handler, "/v1/focus", { method: "POST", body: JSON.stringify({ window: "notepad" }) })).json()) as DesktopWindow;
    expect(focused.hwnd).toBe(10);
    expect((await call(handler, "/v1/focus", { method: "POST", body: JSON.stringify({ window: "solstice" }) })).status).toBe(409);
    expect((await call(handler, "/v1/focus", { method: "POST", body: JSON.stringify({ window: "999" }) })).status).toBe(404);
    const shot = await call(handler, "/v1/shot?window=11");
    expect(shot.headers.get("x-relay-rect")).toBe("5,6,7,8");
    expect(shot.headers.get("x-relay-black")).toBe("1");
    expect(d.shotWindow).toHaveBeenCalledWith(11);
  });

  it("serves the full screen as PNG with its desktop rect", async () => {
    const res = await call(agentHandler(deps()), "/v1/shot");
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-relay-rect")).toBe("-1920,0,3840,1080");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(Uint8Array.of(0x89, 0x50));
  });

  it("reads and writes the clipboard", async () => {
    const d = deps();
    const handler = agentHandler(d);
    expect(await (await call(handler, "/v1/clipboard")).json()).toEqual({ text: "text" });
    expect((await call(handler, "/v1/clipboard", { method: "PUT", body: JSON.stringify({ text: "new" }) })).status).toBe(200);
    expect(d.writeClipboard).toHaveBeenCalledWith("new");
  });
});

import { describe, expect, it, vi } from "vitest";
import type { DesktopWindow } from "../src/desktop";
import { launch, quoteArg } from "../src/agent/launch";

const win = (hwnd: number, pid: number, title = `w${hwnd}`): DesktopWindow => ({
  hwnd,
  title,
  pid,
  process: "x.exe",
  rect: { x: 0, y: 0, width: 10, height: 10 },
  minimized: false,
  foreground: false,
});

describe("quoteArg", () => {
  it.each([
    ["plain", "plain"],
    ["", '""'],
    ["two words", '"two words"'],
    ['say "hi"', '"say \\"hi\\""'],
    ["C:\\dir with space\\", '"C:\\dir with space\\\\"'],
    ["C:\\no\\space", "C:\\no\\space"],
  ])("%j -> %s", (arg, quoted) => {
    expect(quoteArg(arg)).toBe(quoted);
  });
});

describe("launch", () => {
  it("waits for a new window and focuses the launched process's one first", async () => {
    const existing = win(1, 10);
    const lists = [[existing], [existing], [existing, win(2, 99, "splash of another app"), win(3, 42)]];
    const focusWindow = vi.fn((hwnd: number) => ({ ...win(hwnd, 42), foreground: true }));
    const result = await launch(
      { target: "app.exe" },
      {
        listWindows: () => lists.shift() ?? [],
        focusWindow,
        start: () => Promise.resolve(42),
        sleep: () => Promise.resolve(),
      },
    );
    expect(focusWindow).toHaveBeenCalledWith(3);
    expect(result.windows.map((w) => w.hwnd)).toEqual([3, 2]);
    expect(result.focused?.foreground).toBe(true);
  });

  it("returns without a window when none appears in time", async () => {
    const result = await launch(
      { target: "https://example.com", waitMs: 0 },
      { listWindows: () => [win(1, 10)], focusWindow: vi.fn(), start: () => Promise.resolve(null), sleep: () => Promise.resolve() },
    );
    expect(result).toEqual({ pid: null, windows: [], focused: null });
  });
});

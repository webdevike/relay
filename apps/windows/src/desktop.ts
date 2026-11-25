// What the agent channel reads and changes on Isaac's desktop: top-level windows (list, focus),
// screenshots (whole virtual screen or one window) and the clipboard's text. All of it is user32 /
// gdi32 / dwmapi through bun:ffi, so it only works from a process in his interactive session.

import { FFIType, JSCallback, ptr, toArrayBuffer } from "bun:ffi";
import { basename } from "node:path";
import { encodeInputs } from "./input";
import { encodePng } from "./png";
import { dwmapi, fromWide, gdi32, kernel32, sendInput, user32, wide, type Handle } from "./win32";

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DesktopWindow {
  readonly hwnd: number;
  readonly title: string;
  readonly pid: number;
  /** Executable file name, e.g. `notepad.exe`; empty when the process cannot be opened (elevated). */
  readonly process: string;
  /** Visible frame in physical desktop pixels (no invisible resize borders). */
  readonly rect: Rect;
  readonly minimized: boolean;
  readonly foreground: boolean;
}

const GW_OWNER = 4;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;
const DWMWA_CLOAKED = 14;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SW_RESTORE = 9;
const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;
const SRCCOPY = 0x00cc0020;
const CAPTUREBLT = 0x40000000;
const PW_RENDERFULLCONTENT = 2;
const DIB_RGB_COLORS = 0;
const CF_UNICODETEXT = 13;
const GMEM_MOVEABLE = 0x0002;

function readRect(buffer: Uint8Array): Rect {
  const view = new DataView(buffer.buffer, buffer.byteOffset, 16);
  const left = view.getInt32(0, true);
  const top = view.getInt32(4, true);
  return { x: left, y: top, width: view.getInt32(8, true) - left, height: view.getInt32(12, true) - top };
}

/** The window's visible frame: DWM's extended frame bounds, else GetWindowRect. */
function frame(hwnd: Handle): Rect {
  const rect = new Uint8Array(16);
  if (dwmapi().DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, ptr(rect), 16) !== 0)
    user32().GetWindowRect(hwnd, ptr(rect));
  return readRect(rect);
}

function outerRect(hwnd: Handle): Rect {
  const rect = new Uint8Array(16);
  user32().GetWindowRect(hwnd, ptr(rect));
  return readRect(rect);
}

function processName(pid: number): string {
  const process = kernel32().OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (process === null) return "";
  try {
    const path = new Uint8Array(1024 * 2);
    const size = new Uint32Array([1024]);
    if (kernel32().QueryFullProcessImageNameW(process, 0, ptr(path), ptr(size)) === 0) return "";
    return basename(fromWide(path).replaceAll("\\", "/"));
  } finally {
    kernel32().CloseHandle(process);
  }
}

/** HWNDs as numbers or bigints (bun:ffi gives a bigint above 2^53) compared by value. */
function sameHandle(a: Handle, b: Handle | null): boolean {
  return b !== null && BigInt(a) === BigInt(b);
}

function describe(hwnd: Handle, foreground: Handle | null): DesktopWindow {
  const u = user32();
  const length = u.GetWindowTextLengthW(hwnd);
  const title = new Uint8Array((length + 1) * 2);
  u.GetWindowTextW(hwnd, ptr(title), length + 1);
  const pid = new Uint32Array(1);
  u.GetWindowThreadProcessId(hwnd, ptr(pid));
  return {
    hwnd: Number(hwnd),
    title: fromWide(title),
    pid: pid[0] ?? 0,
    process: processName(pid[0] ?? 0),
    rect: frame(hwnd),
    minimized: u.IsIconic(hwnd) !== 0,
    foreground: sameHandle(hwnd, foreground),
  };
}

/**
 * The windows Alt+Tab would show, front to back: visible, titled, unowned top-level windows that
 * DWM has not cloaked (suspended UWP apps and windows on other virtual desktops are cloaked).
 */
export function listWindows(): DesktopWindow[] {
  const u = user32();
  const handles: Handle[] = [];
  const cloaked = new Uint32Array(1);
  const callback = new JSCallback(
    (hwnd: Handle) => {
      if (u.IsWindowVisible(hwnd) === 0 || u.GetWindowTextLengthW(hwnd) === 0 || u.GetWindow(hwnd, GW_OWNER) !== null)
        return 1;
      cloaked[0] = 0;
      dwmapi().DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, ptr(cloaked), 4);
      if (cloaked[0] === 0) handles.push(hwnd);
      return 1;
    },
    { args: [FFIType.ptr, FFIType.i64], returns: FFIType.i32 },
  );
  try {
    if (callback.ptr === null) throw new Error("could not create the EnumWindows callback");
    u.EnumWindows(callback.ptr, 0);
  } finally {
    callback.close();
  }
  const foreground = u.GetForegroundWindow();
  return handles.map((hwnd) => describe(hwnd, foreground));
}

const VK_MENU = 0x12;
const altDown = encodeInputs([{ kind: "key", vk: VK_MENU, scan: 0, flags: 0 }]);
const altUp = encodeInputs([{ kind: "key", vk: VK_MENU, scan: 0, flags: 2 }]);

/**
 * Restores `hwnd` if minimized and makes it the foreground window. Windows only lets the process
 * that owns the foreground take it away. On refusal this host first attaches its input queue to the
 * foreground window's thread (Windows then treats both as one input owner), and if that is refused
 * too, holds Alt while asking, which lifts the foreground lock. A window of a higher integrity level
 * (an elevated app, a Windows Security prompt) can still keep it; `foreground` in the result says.
 */
export function focusWindow(hwnd: number): DesktopWindow {
  const u = user32();
  const target = hwnd as Handle;
  if (u.IsWindow(target) === 0) throw new Error(`no window ${hwnd}`);
  if (u.IsIconic(target) !== 0) u.ShowWindow(target, SW_RESTORE);
  const isForeground = (): boolean => sameHandle(target, u.GetForegroundWindow());
  if (u.SetForegroundWindow(target) === 0 || !isForeground()) {
    const current = u.GetForegroundWindow();
    const theirs = current === null ? 0 : u.GetWindowThreadProcessId(current, null);
    const ours = kernel32().GetCurrentThreadId();
    const attached = theirs !== 0 && theirs !== ours && u.AttachThreadInput(ours, theirs, 1) !== 0;
    try {
      u.BringWindowToTop(target);
      u.SetForegroundWindow(target);
    } finally {
      if (attached) u.AttachThreadInput(ours, theirs, 0);
    }
  }
  if (!isForeground()) {
    sendInput(altDown, 1);
    try {
      u.SetForegroundWindow(target);
    } finally {
      sendInput(altUp, 1);
    }
  }
  return describe(target, u.GetForegroundWindow());
}

/** The bounds of every monitor together, in physical pixels (may start left of or above 0,0). */
export function virtualScreen(): Rect {
  const u = user32();
  return {
    x: u.GetSystemMetrics(SM_XVIRTUALSCREEN),
    y: u.GetSystemMetrics(SM_YVIRTUALSCREEN),
    width: u.GetSystemMetrics(SM_CXVIRTUALSCREEN),
    height: u.GetSystemMetrics(SM_CYVIRTUALSCREEN),
  };
}

/**
 * Runs `draw` into a fresh `width` x `height` bitmap and returns its pixels as top-down BGRA. The
 * bitmap is a DIB section, so its pixels already sit in this process's memory in that layout and
 * are read directly rather than copied out with GetDIBits.
 */
function capture(width: number, height: number, draw: (dc: Handle, screen: Handle) => void): Uint8Array {
  const u = user32();
  const g = gdi32();
  const screen = u.GetDC(null);
  if (screen === null) throw new Error("GetDC failed (is the session's desktop available?)");
  // BITMAPINFOHEADER: 32-bit BI_RGB, negative height for top-down rows.
  const info = new Uint8Array(44);
  const view = new DataView(info.buffer);
  view.setUint32(0, 40, true);
  view.setInt32(4, width, true);
  view.setInt32(8, -height, true);
  view.setUint16(12, 1, true);
  view.setUint16(14, 32, true);
  const bits = new BigUint64Array(1);
  const dc = g.CreateCompatibleDC(screen);
  const bitmap = g.CreateDIBSection(screen, ptr(info), DIB_RGB_COLORS, ptr(bits), null, 0);
  try {
    const pixels = bits[0] ?? 0n;
    if (dc === null || bitmap === null || pixels === 0n) throw new Error(`could not allocate a ${width}x${height} bitmap`);
    const previous = g.SelectObject(dc, bitmap);
    draw(dc, screen);
    g.GdiFlush();
    g.SelectObject(dc, previous);
    return new Uint8Array(toArrayBuffer(pixels, 0, width * height * 4)).slice();
  } finally {
    if (bitmap !== null) g.DeleteObject(bitmap);
    if (dc !== null) g.DeleteDC(dc);
    u.ReleaseDC(null, screen);
  }
}

function copyFromScreen(rect: Rect): Uint8Array {
  return capture(rect.width, rect.height, (dc, screen) => {
    if (gdi32().BitBlt(dc, 0, 0, rect.width, rect.height, screen, rect.x, rect.y, SRCCOPY | CAPTUREBLT) === 0)
      throw new Error(`BitBlt failed (error ${kernel32().GetLastError()}; locked screen or secure desktop?)`);
  });
}

/** True when every pixel's colour is 0: a locked screen, or a window PrintWindow could not render. */
export function isBlack(bgra: Uint8Array): boolean {
  for (let i = 0; i < bgra.length; i += 4) if ((bgra[i] ?? 0) | (bgra[i + 1] ?? 0) | (bgra[i + 2] ?? 0)) return false;
  return true;
}

export interface Screenshot {
  readonly png: Uint8Array;
  /** Desktop pixels the image covers; image pixel (0,0) is (rect.x, rect.y). */
  readonly rect: Rect;
  readonly black: boolean;
}

/** The whole virtual screen. */
export function shootScreen(): Screenshot {
  const rect = virtualScreen();
  const pixels = copyFromScreen(rect);
  return { png: encodePng(pixels, rect.width, rect.height), rect, black: isBlack(pixels) };
}

function crop(bgra: Uint8Array, stride: number, x: number, y: number, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const from = ((y + row) * stride + x) * 4;
    out.set(bgra.subarray(from, from + width * 4), row * width * 4);
  }
  return out;
}

/**
 * One window's visible frame. PrintWindow renders it even when covered; GPU-presented windows
 * (games, some browsers) can come back black that way, so a black result falls back to the
 * screen's pixels inside the frame, which shows whatever is on top of it.
 */
export function shootWindow(hwnd: number): Screenshot {
  const target = hwnd as Handle;
  if (user32().IsWindow(target) === 0) throw new Error(`no window ${hwnd}`);
  if (user32().IsIconic(target) !== 0) throw new Error("the window is minimized; focus it first");
  const rect = frame(target);
  const outer = outerRect(target);
  const full = capture(outer.width, outer.height, (dc) => {
    user32().PrintWindow(target, dc, PW_RENDERFULLCONTENT);
  });
  let pixels = crop(full, outer.width, rect.x - outer.x, rect.y - outer.y, rect.width, rect.height);
  if (isBlack(pixels)) pixels = copyFromScreen(rect);
  return { png: encodePng(pixels, rect.width, rect.height), rect, black: isBlack(pixels) };
}

/** Another process may hold the clipboard for a moment (a clipboard manager reading it); retry briefly. */
async function withClipboard<T>(use: () => T): Promise<T> {
  const u = user32();
  for (let attempt = 0; u.OpenClipboard(null) === 0; attempt++) {
    if (attempt === 20) throw new Error("the clipboard is held by another process");
    await Bun.sleep(25);
  }
  try {
    return use();
  } finally {
    u.CloseClipboard();
  }
}

/** The clipboard's text, or null when it holds no text (an image, files, nothing). */
export function readClipboardText(): Promise<string | null> {
  return withClipboard(() => {
    const data = user32().GetClipboardData(CF_UNICODETEXT);
    if (data === null) return null;
    const k = kernel32();
    const size = Number(k.GlobalSize(data));
    const locked = k.GlobalLock(data);
    if (locked === null) return null;
    try {
      return fromWide(new Uint8Array(toArrayBuffer(locked, 0, size)).slice());
    } finally {
      k.GlobalUnlock(data);
    }
  });
}

/** Replaces the clipboard with `text`. */
export function writeClipboardText(text: string): Promise<void> {
  return withClipboard(() => {
    const u = user32();
    const k = kernel32();
    const bytes = wide(text);
    const memory = k.GlobalAlloc(GMEM_MOVEABLE, bytes.length);
    if (memory === null) throw new Error("GlobalAlloc failed");
    const locked = k.GlobalLock(memory);
    if (locked === null) {
      k.GlobalFree(memory);
      throw new Error("GlobalLock failed");
    }
    k.RtlMoveMemory(locked, ptr(bytes), bytes.length);
    k.GlobalUnlock(memory);
    u.EmptyClipboard();
    // On success the system owns the memory; on failure it is still ours to free.
    if (u.SetClipboardData(CF_UNICODETEXT, memory) === null) {
      k.GlobalFree(memory);
      throw new Error("SetClipboardData failed");
    }
  });
}

// Win32 entry points the Windows host calls through bun:ffi. Each DLL is opened on first use; only
// the host itself imports this file (tests cover the pure modules, which never load bun:ffi).

import { dlopen, FFIType, ptr, type ConvertFns, type Pointer, type Symbols } from "bun:ffi";
import { INPUT_SIZE } from "./input";

const { ptr: P, i32, u32, u16, i64, u64, void: VOID } = FFIType;

/**
 * A HANDLE, HWND or HDC as bun:ffi passes it: a number, or a bigint above 2^53. GDI handles are
 * sign-extended 32-bit values, so a bigint is common and must be passed back as is (converting it
 * to a number corrupts it: BitBlt then fails with ERROR_INVALID_HANDLE).
 */
export type Handle = Pointer | bigint;

/** `name`'s symbols, opened on the first call and kept. */
function library<Fns extends Symbols>(name: string, symbols: Fns): () => ConvertFns<Fns> {
  let loaded: ConvertFns<Fns> | null = null;
  return () => (loaded ??= dlopen(name, symbols).symbols);
}

export const user32 = library("user32.dll", {
  SendInput: { args: [u32, P, i32], returns: u32 },
  GetSystemMetrics: { args: [i32], returns: i32 },
  SetProcessDpiAwarenessContext: { args: [i64], returns: i32 },
  EnumWindows: { args: [P, i64], returns: i32 },
  GetWindowTextW: { args: [P, P, i32], returns: i32 },
  GetWindowTextLengthW: { args: [P], returns: i32 },
  IsWindow: { args: [P], returns: i32 },
  IsWindowVisible: { args: [P], returns: i32 },
  IsIconic: { args: [P], returns: i32 },
  GetWindow: { args: [P, u32], returns: P },
  GetWindowThreadProcessId: { args: [P, P], returns: u32 },
  GetWindowRect: { args: [P, P], returns: i32 },
  GetForegroundWindow: { args: [], returns: P },
  SetForegroundWindow: { args: [P], returns: i32 },
  BringWindowToTop: { args: [P], returns: i32 },
  ShowWindow: { args: [P, i32], returns: i32 },
  GetDC: { args: [P], returns: P },
  ReleaseDC: { args: [P, P], returns: i32 },
  PrintWindow: { args: [P, P, u32], returns: i32 },
  OpenClipboard: { args: [P], returns: i32 },
  AttachThreadInput: { args: [u32, u32, i32], returns: i32 },
  CloseClipboard: { args: [], returns: i32 },
  EmptyClipboard: { args: [], returns: i32 },
  GetClipboardData: { args: [u32], returns: P },
  SetClipboardData: { args: [u32, P], returns: P },
});

export const gdi32 = library("gdi32.dll", {
  CreateCompatibleDC: { args: [P], returns: P },
  CreateDIBSection: { args: [P, P, u32, P, P, u32], returns: P },
  SelectObject: { args: [P, P], returns: P },
  BitBlt: { args: [P, i32, i32, i32, i32, P, i32, i32, u32], returns: i32 },
  GdiFlush: { args: [], returns: i32 },
  DeleteObject: { args: [P], returns: i32 },
  DeleteDC: { args: [P], returns: i32 },
});

export const kernel32 = library("kernel32.dll", {
  GetLastError: { args: [], returns: u32 },
  GlobalAlloc: { args: [u32, u64], returns: P },
  GlobalLock: { args: [P], returns: P },
  GlobalUnlock: { args: [P], returns: i32 },
  GlobalSize: { args: [P], returns: u64 },
  GlobalFree: { args: [P], returns: P },
  RtlMoveMemory: { args: [P, P, u64], returns: VOID },
  OpenProcess: { args: [u32, i32, u32], returns: P },
  QueryFullProcessImageNameW: { args: [P, u32, P, P], returns: i32 },
  GetCurrentThreadId: { args: [], returns: u32 },
  CloseHandle: { args: [P], returns: i32 },
});

export const dwmapi = library("dwmapi.dll", {
  DwmGetWindowAttribute: { args: [P, u32, P, u32], returns: i32 },
});

export const dnsapi = library("dnsapi.dll", {
  DnsServiceConstructInstance: { args: [P, P, P, P, u16, u16, u16, u32, P, P], returns: P },
  DnsServiceFreeInstance: { args: [P], returns: VOID },
  DnsServiceRegister: { args: [P, P], returns: u32 },
  DnsServiceDeRegister: { args: [P, P], returns: u32 },
});

/** NUL-terminated UTF-16LE for a `PCWSTR` argument. Keep the buffer referenced while the call can read it. */
export function wide(text: string): Buffer {
  return Buffer.from(`${text}\0`, "utf16le");
}

/** The UTF-16LE text in `buffer` up to its first NUL. */
export function fromWide(buffer: Uint8Array): string {
  const text = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).toString("utf16le");
  const nul = text.indexOf("\0");
  return nul === -1 ? text : text.slice(0, nul);
}

/**
 * Makes this process per-monitor DPI aware (v2) so window rects, the cursor and screenshots are
 * physical pixels on every monitor. Must run before the first window call; false when the
 * context was already set (a manifest, or a second call).
 */
export function becomeDpiAware(): boolean {
  const PER_MONITOR_AWARE_V2 = -4;
  return user32().SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2) !== 0;
}

/** SendInput for `count` INPUT records encoded by `input.ts`; returns how many were injected. */
export function sendInput(inputs: Uint8Array, count: number): number {
  return user32().SendInput(count, ptr(inputs), INPUT_SIZE);
}

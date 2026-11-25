// Phone trackpad and keyboard on Windows: SendInput (user32). The shared TrackpadInputSink,
// KeyboardInjector and ClipboardPaster (apps/linux/src/input) decide what to emit and speak Linux
// `KEY_*` codes, as they do for the macOS backend; this file maps them to virtual-key codes at the
// platform boundary and encodes INPUT records. Text goes in as KEYEVENTF_UNICODE, so any Unicode
// types regardless of the keyboard layout. The SendInput call itself is `win32.ts` `sendInput`.
//
// SendInput only reaches the desktop of the session the host runs in (the logon task puts it in
// Isaac's), is refused while the screen is locked, and cannot drive elevated windows (UIPI).

import type { EventPoster, MouseButton } from "@relay/linux/src/input/poster";

/** sizeof(INPUT) on x64: DWORD type, padding, then the 32-byte MOUSEINPUT/KEYBDINPUT union. */
export const INPUT_SIZE = 40;

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_HWHEEL = 0x1000;
const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;

/** One wheel notch (WHEEL_DELTA) per 24 phone pixels, the uinput backend's ratio. */
const WHEEL_UNITS_PER_PIXEL = 120 / 24;

export type InputRecord =
  | { readonly kind: "mouse"; readonly dx: number; readonly dy: number; readonly data: number; readonly flags: number }
  | { readonly kind: "key"; readonly vk: number; readonly scan: number; readonly flags: number };

/** `records` as an INPUT[] for SendInput. */
export function encodeInputs(records: readonly InputRecord[]): Uint8Array {
  const bytes = new Uint8Array(records.length * INPUT_SIZE);
  const view = new DataView(bytes.buffer);
  records.forEach((record, i) => {
    const at = i * INPUT_SIZE;
    if (record.kind === "mouse") {
      view.setUint32(at, INPUT_MOUSE, true);
      view.setInt32(at + 8, record.dx, true);
      view.setInt32(at + 12, record.dy, true);
      view.setInt32(at + 16, record.data, true); // mouseData: wheel deltas are signed
      view.setUint32(at + 20, record.flags, true);
    } else {
      view.setUint32(at, INPUT_KEYBOARD, true);
      view.setUint16(at + 8, record.vk, true);
      view.setUint16(at + 10, record.scan, true);
      view.setUint32(at + 12, record.flags, true);
    }
  });
  return bytes;
}

/** Virtual-key code and whether it is an extended key, by Linux keycode (linux/input-event-codes.h). */
const VIRTUAL_KEYS = new Map<number, { readonly vk: number; readonly extended: boolean }>();
function map(codes: readonly number[], vks: readonly number[], extended = false): void {
  codes.forEach((code, i) => {
    const vk = vks[i];
    if (vk !== undefined) VIRTUAL_KEYS.set(code, { vk, extended });
  });
}
const ascii = (chars: string): number[] => Array.from({ length: chars.length }, (_, i) => chars.charCodeAt(i));
map([1, 14, 15, 28, 57], [0x1b, 0x08, 0x09, 0x0d, 0x20]); // Esc, Backspace, Tab, Enter, Space
map([2, 3, 4, 5, 6, 7, 8, 9, 10, 11], ascii("1234567890"));
map([16, 17, 18, 19, 20, 21, 22, 23, 24, 25], ascii("QWERTYUIOP"));
map([30, 31, 32, 33, 34, 35, 36, 37, 38], ascii("ASDFGHJKL"));
map([44, 45, 46, 47, 48, 49, 50], ascii("ZXCVBNM"));
// - = [ ] ; ' ` \ , . /  (VK_OEM_*)
map([12, 13, 26, 27, 39, 40, 41, 43, 51, 52, 53], [0xbd, 0xbb, 0xdb, 0xdd, 0xba, 0xde, 0xc0, 0xdc, 0xbc, 0xbe, 0xbf]);
map([42, 54, 29, 56], [0xa0, 0xa1, 0xa2, 0xa4]); // LShift, RShift, LCtrl, LAlt
map([97, 100, 125, 126], [0xa3, 0xa5, 0x5b, 0x5c], true); // RCtrl, RAlt, LWin, RWin
map([59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88], [0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x7b]);
// Up, Left, Right, Down, Home, End, PageUp, PageDown, Insert, Delete
map([103, 105, 106, 108, 102, 107, 104, 109, 110, 111], [0x26, 0x25, 0x27, 0x28, 0x24, 0x23, 0x21, 0x22, 0x2d, 0x2e], true);

/** The virtual key for Linux keycode `code`; throws for one the phone never sends. */
export function virtualKey(code: number): { readonly vk: number; readonly extended: boolean } {
  const key = VIRTUAL_KEYS.get(code);
  if (key === undefined) throw new Error(`no Windows virtual key for Linux keycode ${code}`);
  return key;
}

function key(code: number, up: boolean): InputRecord {
  const { vk, extended } = virtualKey(code);
  return { kind: "key", vk, scan: 0, flags: (extended ? KEYEVENTF_EXTENDEDKEY : 0) | (up ? KEYEVENTF_KEYUP : 0) };
}

const mouse = (flags: number, dx = 0, dy = 0, data = 0): InputRecord => ({ kind: "mouse", dx, dy, data, flags });

/** Delivers an encoded INPUT[] of `count` records (`win32.ts` `sendInput`); returns how many were injected. */
export type InputSender = (inputs: Uint8Array, count: number) => number;

export class WindowsInputDevice implements EventPoster {
  private readonly held = new Set<MouseButton>();

  constructor(private readonly send: InputSender) {}

  moveBy(dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    this.post([mouse(MOUSEEVENTF_MOVE, dx, dy)]);
  }

  button(button: MouseButton, down: boolean): void {
    const flags =
      button === "left"
        ? down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP
        : down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
    if (down) this.held.add(button);
    else this.held.delete(button);
    this.post([mouse(flags)]);
  }

  /**
   * Positive `dy` scrolls content up, which is a forward wheel turn (positive WHEEL delta). The
   * protocol's `dx` follows macOS (positive = left) and HWHEEL's positive is right, so it flips.
   */
  scroll(dx: number, dy: number): void {
    const vertical = Math.round(dy * WHEEL_UNITS_PER_PIXEL);
    const horizontal = -Math.round(dx * WHEEL_UNITS_PER_PIXEL);
    const records: InputRecord[] = [];
    if (vertical !== 0) records.push(mouse(MOUSEEVENTF_WHEEL, 0, 0, vertical));
    if (horizontal !== 0) records.push(mouse(MOUSEEVENTF_HWHEEL, 0, 0, horizontal));
    if (records.length > 0) this.post(records);
  }

  tapKey(code: number, modifiers: readonly number[] = []): void {
    this.post([
      ...modifiers.map((modifier) => key(modifier, false)),
      key(code, false),
      key(code, true),
      ...modifiers.toReversed().map((modifier) => key(modifier, true)),
    ]);
  }

  /** One newline-free segment as Unicode key events: a down and an up per UTF-16 code unit. */
  typeText(text: string): Promise<void> {
    const records: InputRecord[] = [];
    for (let i = 0; i < text.length; i++) {
      const unit = text.charCodeAt(i);
      records.push({ kind: "key", vk: 0, scan: unit, flags: KEYEVENTF_UNICODE });
      records.push({ kind: "key", vk: 0, scan: unit, flags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP });
    }
    if (records.length > 0) this.post(records);
    return Promise.resolve();
  }

  /** Releases a button a drag left down, so the desktop is not stuck mid-drag after the host stops. */
  close(): void {
    for (const button of [...this.held]) this.button(button, false);
  }

  /** SendInput injects nothing while the screen is locked or a secure desktop (UAC) is up; the event is dropped. */
  private post(records: readonly InputRecord[]): void {
    this.send(encodeInputs(records), records.length);
  }
}

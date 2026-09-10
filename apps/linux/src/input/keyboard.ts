// Port of KeyboardInjector.swift. Named keys always go through uinput. Dictated text goes
// through `wtype` on Wayland: it speaks the virtual-keyboard protocol with its own keymap, so it
// types arbitrary Unicode regardless of the user's layout. Without a Wayland session (or without
// wtype installed) text falls back to uinput with a US-layout table, which covers ASCII only.
// Newlines are pressed as Return in both paths, mirroring the Mac.

import type { KeyName } from "@relay/protocol";
import { AckFailure, type TextInjecting } from "../seams";
import type { EventPoster } from "./poster";

// linux/input-event-codes.h
const KEY_ESC = 1;
const KEY_BACKSPACE = 14;
const KEY_TAB = 15;
const KEY_ENTER = 28;
const KEY_LEFTSHIFT = 42;
const KEY_SPACE = 57;

const KEY_CODE: Record<KeyName, number> = {
  return: KEY_ENTER,
  escape: KEY_ESC,
  backspace: KEY_BACKSPACE,
  tab: KEY_TAB,
};

/** US QWERTY: unshifted and shifted characters by keycode row. */
const US_ROWS: readonly (readonly [firstCode: number, plain: string, shifted: string])[] = [
  [2, "1234567890-=", "!@#$%^&*()_+"],
  [16, "qwertyuiop[]", "QWERTYUIOP{}"],
  [30, "asdfghjkl;'`", 'ASDFGHJKL:"~'],
  [43, "\\", "|"],
  [44, "zxcvbnm,./", "ZXCVBNM<>?"],
];

const US_KEYMAP: Record<string, { readonly code: number; readonly shift: boolean }> = { " ": { code: KEY_SPACE, shift: false } };
for (const [first, plain, shifted] of US_ROWS) {
  for (let i = 0; i < plain.length; i++) {
    US_KEYMAP[plain.charAt(i)] = { code: first + i, shift: false };
    US_KEYMAP[shifted.charAt(i)] = { code: first + i, shift: true };
  }
}

export type TextTyper = (text: string) => Promise<void>;

export class KeyboardInjector implements TextInjecting {
  /**
   * @param typeText Types one newline-free segment; `null` selects the uinput US-layout path.
   */
  constructor(
    private readonly poster: EventPoster,
    private readonly typeText: TextTyper | null,
  ) {}

  async insert(text: string): Promise<void> {
    const segments = text.split("\n");
    for (let i = 0; i < segments.length; i++) {
      if (i > 0) this.poster.tapKey(KEY_ENTER);
      const segment = segments[i] ?? "";
      if (segment.length === 0) continue;
      if (this.typeText !== null) await this.typeText(segment);
      else this.typeAscii(segment);
    }
  }

  press(key: KeyName): Promise<void> {
    this.poster.tapKey(KEY_CODE[key]);
    return Promise.resolve();
  }

  private typeAscii(segment: string): void {
    for (const char of segment) {
      const mapped = US_KEYMAP[char];
      if (mapped === undefined) {
        throw new AckFailure({
          code: "invalid_command",
          message: `cannot type ${JSON.stringify(char)} without a Wayland session (install wtype)`,
        });
      }
      this.poster.tapKey(mapped.code, mapped.shift ? [KEY_LEFTSHIFT] : []);
    }
  }
}

/** `wtype -- <segment>`; rejects with an `internal` AckFailure when wtype exits non-zero. */
export async function wtypeText(segment: string): Promise<void> {
  const proc = Bun.spawn(["wtype", "--", segment], { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = (await new Response(proc.stderr).text()).trim();
    throw new AckFailure({ code: "internal", message: `wtype exited ${code}${stderr.length > 0 ? `: ${stderr}` : ""}` });
  }
}

/** Picks the text path for this session: wtype when Wayland and the binary exist, else null. */
export function detectTextTyper(): TextTyper | null {
  if (process.env["WAYLAND_DISPLAY"] === undefined) return null;
  return Bun.which("wtype") === null ? null : wtypeText;
}

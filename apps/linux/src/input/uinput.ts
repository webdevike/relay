// A virtual mouse+keyboard on /dev/uinput. Kernel-level, so it works under Wayland and X11
// alike and needs no compositor cooperation: the compositor sees an ordinary evdev device.
//
// Requires read/write on /dev/uinput (typically: user in the `input` group, or a udev rule).
// Only `ioctl` needs FFI; the fd itself comes from node:fs and reports are plain `write`s.
//
// Layout constants are x86_64 / aarch64 Linux (both have a 24-byte `input_event`: two 64-bit
// timeval fields, u16 type, u16 code, s32 value).

import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, constants, openSync, writeSync } from "node:fs";
import type { EventPoster, MouseButton } from "./poster";

// linux/input-event-codes.h
const EV_SYN = 0x00;
const EV_KEY = 0x01;
const EV_REL = 0x02;
const SYN_REPORT = 0;
const REL_X = 0x00;
const REL_Y = 0x01;
const REL_HWHEEL = 0x06;
const REL_WHEEL = 0x08;
const REL_WHEEL_HI_RES = 0x0b;
const REL_HWHEEL_HI_RES = 0x0c;
const BTN_LEFT = 0x110;
const BTN_RIGHT = 0x111;
const BTN_MIDDLE = 0x112;
const KEY_MAX_PLAIN = 0xff; // KEY_* codes we expose; BTN_* are enabled individually
const BUS_VIRTUAL = 0x06;

// linux/uinput.h ioctl numbers (x86_64 / aarch64 share these encodings)
const UI_DEV_CREATE = 0x5501;
const UI_DEV_DESTROY = 0x5502;
const UI_DEV_SETUP = 0x405c5503; // _IOW('U', 3, struct uinput_setup) with sizeof == 92
const UI_SET_EVBIT = 0x40045564;
const UI_SET_KEYBIT = 0x40045565;
const UI_SET_RELBIT = 0x40045566;

const INPUT_EVENT_SIZE = 24;
const UINPUT_SETUP_SIZE = 92; // input_id (4 x u16) + name[80] + ff_effects_max (u32)
const UINPUT_MAX_NAME_SIZE = 80;

/** One hi-res wheel notch is 120 units; this many phone pixels scroll one notch. */
const PIXELS_PER_NOTCH = 24;
const HI_RES_PER_NOTCH = 120;

const libc = dlopen("libc.so.6", {
  ioctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
});

const BUTTON_CODE: Record<MouseButton, number> = { left: BTN_LEFT, right: BTN_RIGHT };

export class UinputDevice implements EventPoster {
  private readonly fd: number;
  private readonly report = Buffer.alloc(INPUT_EVENT_SIZE * 8);
  private wheelCarry = 0;
  private hwheelCarry = 0;

  /** Throws when /dev/uinput cannot be opened or configured (permissions, missing module). */
  constructor(name = "Relay Virtual Input", path = "/dev/uinput") {
    let fd: number;
    try {
      fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch (error) {
      throw new Error(`cannot open ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      this.enable(fd, UI_SET_EVBIT, EV_KEY);
      this.enable(fd, UI_SET_EVBIT, EV_REL);
      for (let code = 1; code <= KEY_MAX_PLAIN; code++) this.enable(fd, UI_SET_KEYBIT, code);
      for (const code of [BTN_LEFT, BTN_RIGHT, BTN_MIDDLE]) this.enable(fd, UI_SET_KEYBIT, code);
      for (const code of [REL_X, REL_Y, REL_WHEEL, REL_HWHEEL, REL_WHEEL_HI_RES, REL_HWHEEL_HI_RES]) {
        this.enable(fd, UI_SET_RELBIT, code);
      }
      const setup = Buffer.alloc(UINPUT_SETUP_SIZE);
      setup.writeUInt16LE(BUS_VIRTUAL, 0); // bustype
      setup.writeUInt16LE(0x1d6b, 2); // vendor (Linux Foundation)
      setup.writeUInt16LE(0x0104, 4); // product
      setup.writeUInt16LE(1, 6); // version
      setup.write(name.slice(0, UINPUT_MAX_NAME_SIZE - 1), 8, "utf8");
      if (libc.symbols.ioctl(fd, UI_DEV_SETUP, ptr(setup)) < 0) throw new Error("UI_DEV_SETUP failed");
      if (libc.symbols.ioctl(fd, UI_DEV_CREATE, 0) < 0) throw new Error("UI_DEV_CREATE failed");
    } catch (error) {
      closeSync(fd);
      throw error;
    }
    this.fd = fd;
  }

  moveBy(dx: number, dy: number): void {
    let n = 0;
    if (dx !== 0) n = this.put(n, EV_REL, REL_X, dx);
    if (dy !== 0) n = this.put(n, EV_REL, REL_Y, dy);
    if (n === 0) return;
    this.flush(this.put(n, EV_SYN, SYN_REPORT, 0));
  }

  button(button: MouseButton, down: boolean): void {
    let n = this.put(0, EV_KEY, BUTTON_CODE[button], down ? 1 : 0);
    n = this.put(n, EV_SYN, SYN_REPORT, 0);
    this.flush(n);
  }

  /**
   * Hi-res wheel units every report (libinput >= 1.16 and all current compositors consume
   * these), plus a legacy REL_WHEEL click whenever a whole notch accumulates so older consumers
   * still scroll. Linux: positive REL_WHEEL scrolls up, positive REL_HWHEEL scrolls right; the
   * protocol's `dx` follows macOS (positive = left), hence the sign flip on the horizontal axis.
   */
  scroll(dx: number, dy: number): void {
    const vertical = Math.round((dy * HI_RES_PER_NOTCH) / PIXELS_PER_NOTCH);
    const horizontal = -Math.round((dx * HI_RES_PER_NOTCH) / PIXELS_PER_NOTCH);
    if (vertical === 0 && horizontal === 0) return;
    let n = 0;
    if (vertical !== 0) {
      n = this.put(n, EV_REL, REL_WHEEL_HI_RES, vertical);
      this.wheelCarry += vertical;
      const notches = Math.trunc(this.wheelCarry / HI_RES_PER_NOTCH);
      if (notches !== 0) {
        this.wheelCarry -= notches * HI_RES_PER_NOTCH;
        n = this.put(n, EV_REL, REL_WHEEL, notches);
      }
    }
    if (horizontal !== 0) {
      n = this.put(n, EV_REL, REL_HWHEEL_HI_RES, horizontal);
      this.hwheelCarry += horizontal;
      const notches = Math.trunc(this.hwheelCarry / HI_RES_PER_NOTCH);
      if (notches !== 0) {
        this.hwheelCarry -= notches * HI_RES_PER_NOTCH;
        n = this.put(n, EV_REL, REL_HWHEEL, notches);
      }
    }
    this.flush(this.put(n, EV_SYN, SYN_REPORT, 0));
  }

  tapKey(code: number, modifiers: readonly number[] = []): void {
    let n = 0;
    for (const modifier of modifiers) n = this.put(n, EV_KEY, modifier, 1);
    n = this.put(n, EV_KEY, code, 1);
    n = this.put(n, EV_SYN, SYN_REPORT, 0);
    n = this.put(n, EV_KEY, code, 0);
    for (const modifier of modifiers) n = this.put(n, EV_KEY, modifier, 0);
    this.flush(this.put(n, EV_SYN, SYN_REPORT, 0));
  }

  close(): void {
    libc.symbols.ioctl(this.fd, UI_DEV_DESTROY, 0);
    closeSync(this.fd);
  }

  private enable(fd: number, request: number, code: number): void {
    if (libc.symbols.ioctl(fd, request, code) < 0) {
      throw new Error(`ioctl 0x${request.toString(16)} (${code}) failed on /dev/uinput`);
    }
  }

  /** Appends one input_event at slot `n` of the report buffer; returns the next slot. */
  private put(n: number, type: number, code: number, value: number): number {
    const offset = n * INPUT_EVENT_SIZE;
    this.report.fill(0, offset, offset + 16); // timeval: the kernel stamps injected events
    this.report.writeUInt16LE(type, offset + 16);
    this.report.writeUInt16LE(code, offset + 18);
    this.report.writeInt32LE(value, offset + 20);
    return n + 1;
  }

  /** Non-blocking write of `n` events. EAGAIN (kernel queue full) drops the report by design. */
  private flush(n: number): void {
    try {
      writeSync(this.fd, this.report, 0, n * INPUT_EVENT_SIZE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
    }
  }
}

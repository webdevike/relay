import { dlopen, FFIType, ptr } from "bun:ffi";
import { dirname, join } from "node:path";
import type { EventPoster, MouseButton } from "./poster";

/** CoreGraphics input; resolves the native shim beside the compiled host. */
export class MacInputDevice implements EventPoster {
  private readonly library;

  constructor() {
    const path = process.env["RELAY_INPUT_LIBRARY"] ?? join(dirname(process.execPath), "relay-input.dylib");
    this.library = dlopen(path, {
      relay_input_trusted: { args: [], returns: FFIType.i32 },
      relay_input_request: { args: [], returns: FFIType.i32 },
      relay_input_move: { args: [FFIType.f64, FFIType.f64], returns: FFIType.void },
      relay_input_button: { args: [FFIType.i32, FFIType.i32], returns: FFIType.void },
      relay_input_scroll: { args: [FFIType.f64, FFIType.f64], returns: FFIType.void },
      relay_input_key: { args: [FFIType.i32, FFIType.u32], returns: FFIType.void },
      relay_input_text: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.void },
      relay_input_close: { args: [], returns: FFIType.void },
    });
  }

  // Read live: users can grant/revoke Accessibility without restarting the host.
  get granted(): boolean {
    return this.library.symbols.relay_input_trusted() !== 0;
  }

  requestAccess(): void {
    this.library.symbols.relay_input_request();
  }

  moveBy(dx: number, dy: number): void {
    this.library.symbols.relay_input_move(dx, dy);
  }

  button(button: MouseButton, down: boolean): void {
    this.library.symbols.relay_input_button(button === "right" ? 1 : 0, down ? 1 : 0);
  }

  scroll(dx: number, dy: number): void {
    this.library.symbols.relay_input_scroll(dx, dy);
  }

  tapKey(code: number, modifiers: readonly number[] = []): void {
    let flags = 0;
    for (const modifier of modifiers) {
      if (modifier === 42 || modifier === 54) flags |= 1;
      else if (modifier === 29 || modifier === 97 || modifier === 125 || modifier === 126) flags |= 2;
      else if (modifier === 56 || modifier === 100) flags |= 4;
      else throw new Error(`Unsupported macOS key modifier ${modifier}`);
    }
    this.library.symbols.relay_input_key(code, flags);
  }

  async typeText(text: string): Promise<void> {
    if (text.length === 0) return;
    const units = new Uint16Array(text.length);
    for (let i = 0; i < text.length; i++) units[i] = text.charCodeAt(i);
    this.library.symbols.relay_input_text(ptr(units), units.length);
  }

  close(): void {
    this.library.symbols.relay_input_close();
    this.library.close();
  }
}

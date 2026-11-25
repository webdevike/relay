import { KeyboardInjector } from "@relay/linux/src/input/keyboard";
import { ClipboardPaster } from "@relay/linux/src/input/paste";
import { describe, expect, it } from "vitest";
import { INPUT_SIZE, WindowsInputDevice } from "../src/input";

type Decoded =
  | { type: "mouse"; dx: number; dy: number; data: number; flags: number }
  | { type: "key"; vk: number; scan: number; flags: number };

/** Reads INPUT records back at the x64 offsets SendInput uses. */
function decode(bytes: Uint8Array, count: number): Decoded[] {
  expect(bytes.length).toBe(count * INPUT_SIZE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: count }, (_, i) => {
    const at = i * INPUT_SIZE;
    return view.getUint32(at, true) === 0
      ? { type: "mouse", dx: view.getInt32(at + 8, true), dy: view.getInt32(at + 12, true), data: view.getInt32(at + 16, true), flags: view.getUint32(at + 20, true) }
      : { type: "key", vk: view.getUint16(at + 8, true), scan: view.getUint16(at + 10, true), flags: view.getUint32(at + 12, true) };
  });
}

function recorder() {
  const sent: Decoded[][] = [];
  const device = new WindowsInputDevice((bytes, count) => {
    sent.push(decode(bytes, count));
    return count;
  });
  return { device, sent };
}

const KEYUP = 2;
const UNICODE = 4;
const unicode = (unit: number, up = false) => ({ type: "key", vk: 0, scan: unit, flags: UNICODE | (up ? KEYUP : 0) });

describe("WindowsInputDevice", () => {
  it("moves relative and clicks with the button's down and up flags", () => {
    const { device, sent } = recorder();
    device.moveBy(12, -3);
    device.button("right", true);
    device.button("right", false);
    expect(sent).toEqual([
      [{ type: "mouse", dx: 12, dy: -3, data: 0, flags: 0x1 }],
      [{ type: "mouse", dx: 0, dy: 0, data: 0, flags: 0x8 }],
      [{ type: "mouse", dx: 0, dy: 0, data: 0, flags: 0x10 }],
    ]);
  });

  it("scrolls 120 wheel units per 24 phone pixels, horizontal flipped to Windows' right-positive", () => {
    const { device, sent } = recorder();
    device.scroll(24, -48);
    expect(sent).toEqual([
      [
        { type: "mouse", dx: 0, dy: 0, data: -240, flags: 0x800 },
        { type: "mouse", dx: 0, dy: 0, data: -120, flags: 0x1000 },
      ],
    ]);
  });

  it("pastes with Ctrl+V through the shared ClipboardPaster", async () => {
    const { device, sent } = recorder();
    const paster = new ClipboardPaster({ poster: device, copy: () => Promise.resolve(), expect: null });
    await paster.paste({ mimeType: "image/png", data: Buffer.from("png").toString("base64") });
    expect(sent).toEqual([
      [
        { type: "key", vk: 0xa2, scan: 0, flags: 0 },
        { type: "key", vk: 0x56, scan: 0, flags: 0 },
        { type: "key", vk: 0x56, scan: 0, flags: KEYUP },
        { type: "key", vk: 0xa2, scan: 0, flags: KEYUP },
      ],
    ]);
  });

  it("types Unicode per UTF-16 unit and presses Enter for newlines through the shared KeyboardInjector", async () => {
    const { device, sent } = recorder();
    const keyboard = new KeyboardInjector(device, device.typeText.bind(device));
    await keyboard.insert("é\n😀");
    const [hi, lo] = [0xd83d, 0xde00];
    expect(sent).toEqual([
      [unicode(0xe9), unicode(0xe9, true)],
      [
        { type: "key", vk: 0x0d, scan: 0, flags: 0 },
        { type: "key", vk: 0x0d, scan: 0, flags: KEYUP },
      ],
      [unicode(hi), unicode(hi, true), unicode(lo), unicode(lo, true)],
    ]);
  });

  it("marks navigation keys extended so they are not read as the numeric keypad", () => {
    const { device, sent } = recorder();
    device.tapKey(105); // KEY_LEFT
    expect(sent[0]?.[0]).toEqual({ type: "key", vk: 0x25, scan: 0, flags: 1 });
  });

  it("releases a button a drag left down when closed", () => {
    const { device, sent } = recorder();
    device.button("left", true);
    device.close();
    expect(sent.at(-1)).toEqual([{ type: "mouse", dx: 0, dy: 0, data: 0, flags: 0x4 }]);
  });
});

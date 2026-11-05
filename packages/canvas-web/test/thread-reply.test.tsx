// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { openThread, snapThreads, threadsOf } from "../../canvas-live/src/threads";
import { ThreadPopover } from "../src/pins";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
// jsdom has no element scrolling; the popover scrolls its list to the newest message.
Element.prototype.scrollTo = () => undefined;

// The real room module opens a websocket at import; the popover only needs the doc and who I am.
const room = vi.hoisted(() => ({ doc: null as unknown as Y.Doc, yThreads: null as unknown as Y.Map<Y.Map<unknown>> }));
vi.mock("../src/room", () => ({
  get doc() {
    return room.doc;
  },
  get yThreads() {
    return room.yThreads;
  },
  yNodes: new Y.Doc().getMap("nodes"),
  self: { name: "Isaac", color: "#228be6", kind: "human" },
  yMeta: new Y.Doc().getMap("meta"),
  provider: {},
  roomMe: null,
  presenceStates: () => new Map(),
  subscribeDoc: () => () => undefined,
  subscribePresence: () => () => undefined,
}));

afterEach(() => {
  document.body.innerHTML = "";
});

function setup() {
  room.doc = new Y.Doc();
  room.yThreads = threadsOf(room.doc);
  openThread(room.yThreads, "t1", { x: 0, y: 0 }, { id: "m1", kind: "human", name: "Isaac", color: "#228be6", text: "First", ts: 1 });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const draw = () => {
    const thread = snapThreads(room.yThreads)[0]!;
    act(() =>
      root.render(
        <ThreadPopover thread={thread} at={{ x: 100, y: 100 }} bounds={{ width: 800, height: 600 }} sheet={false} presences={new Map()} onClose={() => undefined} />,
      ),
    );
  };
  draw();
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Reply"]')!;
  const type = (value: string) => {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const texts = () => snapThreads(room.yThreads)[0]!.messages.map((m) => m.text);
  return { host, input, type, texts, draw };
}

describe("thread reply box", () => {
  // Relay Desktop embeds the room in a sandboxed iframe without allow-forms: a form submit never
  // fires there, so Enter and Send must post on their own.
  it("posts a follow-up on Enter and clears the box", () => {
    const { input, type, texts } = setup();
    type("Second");
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(texts()).toEqual(["First", "Second"]);
    expect(input.value).toBe("");
  });

  it("posts a follow-up from the Send button, and never an empty one", () => {
    const { host, type, texts, draw } = setup();
    const sendBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
    expect(sendBtn.disabled).toBe(true);
    type("Third");
    act(() => sendBtn.click());
    draw();
    type("   ");
    act(() => sendBtn.click());
    expect(texts()).toEqual(["First", "Third"]);
  });
});

/**
 * The live view page: noVNC inside the web view, bundled into `src/vnc/viewerHtml.ts` by
 * `vnc/build.mjs`. React Native drives it with `window.relayVnc(command)` and hears back through
 * `window.ReactNativeWebView.postMessage` (the contract is `src/vnc/messages.ts`).
 *
 * The desktop is scaled to fit (`scaleViewport`). noVNC's touch gestures stay as they are (tap
 * clicks, two-finger tap right-clicks, long press holds the right button, drag drags, two-finger
 * drag scrolls) except pinch: noVNC sends that to the Mac as Ctrl+scroll, here it zooms the view
 * locally instead, and while zoomed in a one-finger drag pans rather than drags.
 */
import RFB, { type RfbCredentials, type RfbGesture } from "@novnc/novnc";
import type { VncCommand, VncCredentials, VncEvent, VncKey } from "../src/vnc/messages";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(data: string): void };
    relayVnc?: (command: VncCommand) => void;
  }
}

const MAX_ZOOM = 5;
/** X11 keysyms (keysymdef.h). */
const KEYSYMS: Record<VncKey, number> = {
  backspace: 0xff08,
  tab: 0xff09,
  return: 0xff0d,
  escape: 0xff1b,
  left: 0xff51,
  up: 0xff52,
  right: 0xff53,
  down: 0xff54,
};

const target = document.getElementById("screen");
if (target === null) throw new Error("no #screen");
const screen = target;

let rfb: RFB | null = null;
/** Local zoom over the fitted desktop; 1 is fit to the view. */
let zoom = 1;
/** The fitted scale, taken when a pinch starts from fit. */
let fitScale = 1;
let pinch: { distance: number; zoom: number; fbX: number; fbY: number } | null = null;
let panFrom: { x: number; y: number } | null = null;

function post(event: VncEvent): void {
  window.ReactNativeWebView?.postMessage(JSON.stringify(event));
}

/** The keysym for a typed character: Latin-1 maps directly, everything else to the Unicode range. */
function keysymFor(codePoint: number): number {
  if (codePoint === 0x0a) return KEYSYMS.return;
  if ((codePoint >= 0x20 && codePoint <= 0x7e) || (codePoint >= 0xa0 && codePoint <= 0xff)) return codePoint;
  return 0x0100_0000 | codePoint;
}

function rfbCredentials(credentials: VncCredentials): RfbCredentials {
  return credentials.username === "" ? { password: credentials.password } : { username: credentials.username, password: credentials.password };
}

/** noVNC's scrolling container inside `#screen`. */
function scroller(): HTMLElement | null {
  return screen.firstElementChild instanceof HTMLElement ? screen.firstElementChild : null;
}

function applyZoom(client: RFB, next: number, clientX: number, clientY: number, fbX: number, fbY: number): void {
  zoom = next;
  const scale = fitScale * zoom;
  client._display.scale = scale;
  const box = scroller();
  if (box === null) return;
  // Keep the desktop point that was under the fingers under them.
  const rect = box.getBoundingClientRect();
  box.scrollLeft = fbX * scale - (clientX - rect.left);
  box.scrollTop = fbY * scale - (clientY - rect.top);
}

function handlePinch(client: RFB, event: RfbGesture): void {
  const { clientX, clientY, magnitudeX, magnitudeY } = event.detail;
  const distance = Math.hypot(magnitudeX, magnitudeY);
  if (event.type === "gesturestart") {
    if (zoom === 1) fitScale = client._display.scale;
    const canvas = screen.querySelector("canvas");
    const scale = client._display.scale;
    if (canvas === null || scale === 0) return;
    const rect = canvas.getBoundingClientRect();
    pinch = { distance, zoom, fbX: (clientX - rect.left) / scale, fbY: (clientY - rect.top) / scale };
    return;
  }
  if (event.type === "gestureend") {
    pinch = null;
    return;
  }
  if (pinch === null || pinch.distance === 0) return;
  const next = Math.min(MAX_ZOOM, Math.max(1, (pinch.zoom * distance) / pinch.distance));
  applyZoom(client, next, clientX, clientY, pinch.fbX, pinch.fbY);
}

function handlePan(event: RfbGesture): void {
  const { clientX, clientY } = event.detail;
  const box = scroller();
  if (event.type === "gesturestart") panFrom = { x: clientX, y: clientY };
  else if (event.type === "gestureend") panFrom = null;
  else if (panFrom !== null && box !== null) {
    box.scrollLeft += panFrom.x - clientX;
    box.scrollTop += panFrom.y - clientY;
    panFrom = { x: clientX, y: clientY };
  }
}

const handleGesture = RFB.prototype._handleGesture;
RFB.prototype._handleGesture = function (this: RFB, event: RfbGesture): void {
  if (event.detail.type === "pinch") {
    handlePinch(this, event);
    return;
  }
  if (event.detail.type === "drag" && (event.type === "gesturestart" ? zoom > 1 : panFrom !== null)) {
    handlePan(event);
    return;
  }
  handleGesture.call(this, event);
};

// noVNC refits on resize (rotation); the local zoom starts over with it.
window.addEventListener("resize", () => {
  zoom = 1;
  pinch = null;
  panFrom = null;
});

function connect(url: string, credentials: VncCredentials | null): void {
  rfb?.disconnect();
  zoom = 1;
  const client = new RFB(screen, url, {
    wsProtocols: ["binary"],
    shared: true,
    ...(credentials === null ? {} : { credentials: rfbCredentials(credentials) }),
  });
  client.scaleViewport = true;
  client.resizeSession = false;
  client.showDotCursor = true;
  client.background = "#000";
  client.addEventListener("connect", () => {
    post({ type: "connected" });
  });
  client.addEventListener("disconnect", (event) => {
    // A client replaced by a newer `connect` ends quietly.
    if (rfb !== client) return;
    rfb = null;
    post({ type: "disconnected", clean: (event as CustomEvent<{ clean: boolean }>).detail.clean });
  });
  client.addEventListener("credentialsrequired", (event) => {
    post({ type: "credentials", types: (event as CustomEvent<{ types: string[] }>).detail.types });
  });
  client.addEventListener("securityfailure", (event) => {
    post({ type: "securityfailure", reason: (event as CustomEvent<{ reason?: string }>).detail.reason ?? null });
  });
  rfb = client;
}

window.relayVnc = (command) => {
  switch (command.type) {
    case "connect":
      connect(command.url, command.credentials);
      return;
    case "credentials":
      rfb?.sendCredentials(rfbCredentials(command.credentials));
      return;
    case "text":
      for (const char of command.text) {
        const codePoint = char.codePointAt(0);
        if (codePoint !== undefined) rfb?.sendKey(keysymFor(codePoint), null);
      }
      return;
    case "key":
      rfb?.sendKey(KEYSYMS[command.key], null);
      return;
    case "disconnect":
      rfb?.disconnect();
      return;
  }
};

post({ type: "ready" });

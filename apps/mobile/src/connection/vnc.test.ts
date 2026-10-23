import { beforeEach, describe, expect, it } from "vitest";
import { useVncStore } from "@/state/vnc";
import { parseVncEvent, vncCommandScript, vncUrl } from "@/vnc/messages";
import { createVncFrameRouter } from "./vnc";

let authority: string | null = "100.85.157.127:7817";
const route = createVncFrameRouter(useVncStore.getState(), () => authority);

beforeEach(() => {
  authority = "100.85.157.127:7817";
  useVncStore.setState({ access: { kind: "asking" } });
});

describe("vnc frames", () => {
  it("turns a ticket into the bridge URL on the connected host", () => {
    route({ t: "vnc.ticket", ticket: "ab/c d" });
    expect(useVncStore.getState().access).toEqual({ kind: "ready", url: "ws://100.85.157.127:7817/vnc?ticket=ab%2Fc%20d" });
  });

  it("reports Screen Sharing off", () => {
    route({ t: "vnc.unavailable" });
    expect(useVncStore.getState().access).toEqual({ kind: "off" });
  });

  it("drops a ticket that arrives after the socket went away", () => {
    authority = null;
    route({ t: "vnc.ticket", ticket: "t" });
    expect(useVncStore.getState().access).toEqual({ kind: "idle" });
  });

  it("ignores other frames", () => {
    route({ t: "pong", ts: 1, serverTs: 2 });
    expect(useVncStore.getState().access).toEqual({ kind: "asking" });
  });
});

describe("viewer messages", () => {
  it("builds the URL from the already-bracketed IPv6 authority", () => {
    expect(vncUrl("[fd7a::1]:7817", "t")).toBe("ws://[fd7a::1]:7817/vnc?ticket=t");
  });

  it("parses page events and rejects anything else", () => {
    expect(parseVncEvent('{"type":"credentials","types":["username","password"]}')).toEqual({ type: "credentials", types: ["username", "password"] });
    expect(parseVncEvent('{"type":"disconnected","clean":false}')).toEqual({ type: "disconnected", clean: false });
    expect(parseVncEvent('{"type":"securityfailure","reason":null}')).toEqual({ type: "securityfailure", reason: null });
    expect(parseVncEvent('{"type":"connected","extra":1}')).toEqual({ type: "connected" });
    expect(parseVncEvent('{"type":"nope"}')).toBeNull();
    expect(parseVncEvent("keyboard:focused")).toBeNull();
  });

  it("hands commands to the page as JSON", () => {
    expect(vncCommandScript({ type: "text", text: "a\"</script>" })).toBe('window.relayVnc({"type":"text","text":"a\\"</script>"});true;');
  });
});

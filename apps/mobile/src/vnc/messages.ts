/**
 * The contract between the live view's web view page (`vnc/viewer.ts`, noVNC) and React Native.
 * Commands go into the page as `window.relayVnc(command)`; events come back through
 * `window.ReactNativeWebView.postMessage(JSON)` and are parsed here before anything trusts them.
 */
import { z } from "zod";
import { VNC_PATH } from "@relay/protocol";

/** Screen Sharing's own login: a macOS account (ARD auth) or just the VNC password (`username` ""). */
export interface VncCredentials {
  readonly username: string;
  readonly password: string;
}

/** Keys the live view's keyboard sends besides typed text. */
export type VncKey = "backspace" | "return" | "tab" | "escape" | "left" | "right" | "up" | "down";

export type VncCommand =
  /** Open the bridge at `url` (a fresh ticket each time), offering `credentials` up front when known. */
  | { readonly type: "connect"; readonly url: string; readonly credentials: VncCredentials | null }
  /** The answer to a `credentials` event. */
  | { readonly type: "credentials"; readonly credentials: VncCredentials }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "key"; readonly key: VncKey }
  | { readonly type: "disconnect" };

const VncEventSchema = z.discriminatedUnion("type", [
  /** The page loaded and takes commands. */
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("connected") }),
  /** `clean`: ended on purpose (either side), not by a dropped connection. */
  z.object({ type: z.literal("disconnected"), clean: z.boolean() }),
  /** Screen Sharing wants these credential fields (`username`, `password`). */
  z.object({ type: z.literal("credentials"), types: z.array(z.string()) }),
  /** Screen Sharing refused the credentials. */
  z.object({ type: z.literal("securityfailure"), reason: z.string().nullable() }),
]);
export type VncEvent = z.infer<typeof VncEventSchema>;

/** A page message as a `VncEvent`, or null for anything else. */
export function parseVncEvent(data: string): VncEvent | null {
  try {
    const parsed = VncEventSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The script that hands `command` to the page; `injectJavaScript` wants a trailing value. */
export function vncCommandScript(command: VncCommand): string {
  return `window.relayVnc(${JSON.stringify(command)});true;`;
}

/** The bridge URL for `ticket` on the host at `authority` (`host:port`, IPv6 bracketed). */
export function vncUrl(authority: string, ticket: string): string {
  return `ws://${authority}${VNC_PATH}?ticket=${encodeURIComponent(ticket)}`;
}

// The two GPT-Live endpoints a live call uses, with the project key that never leaves the host:
//   - `POST /v1/live/sessions` creates a WebRTC session from the phone's SDP offer and returns
//     OpenAI's answer (GPT-Live has no client secrets: the host is in the setup path instead);
//   - `wss://…/v1/live/sessions/{id}/attach` is the sideband: every transcript and delegation
//     event of that session, and the commands that answer them, while the audio stays on the
//     phone's WebRTC connection.
// The key comes from $OPENAI_API_KEY, else `OPENAI_API_KEY=` in <agent home>/secrets/openai.env.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const LIVE_MODEL = "gpt-live-1";
const API = "https://api.openai.com/v1/live/sessions";
const SIDEBAND = "wss://api.openai.com/v1/live/sessions";

/** A message seeding the voice's context (`session.input`). */
export interface LiveInputMessage {
  readonly role: "developer" | "user" | "assistant";
  readonly text: string;
}

/** What a live call asks GPT-Live for; always client delegation. */
export interface LiveSessionConfig {
  readonly instructions: string;
  readonly voice: string;
  readonly input: readonly LiveInputMessage[];
}

/** One sideband event; `type` picks the shape (see the GPT-Live sideband reference). */
export type LiveEvent = { readonly type: string } & Readonly<Record<string, unknown>>;

export interface SidebandEvents {
  event(event: LiveEvent): void;
  /** The socket closed (`reason`: why, for the log). Never called after `Sideband.close`. */
  closed(reason: string): void;
}

export interface Sideband {
  send(event: Readonly<Record<string, unknown>>): void;
  close(): void;
}

export interface LiveApi {
  /** Creates a WebRTC session from `offer`; rejects with the API's error message. */
  create(config: LiveSessionConfig, offer: string): Promise<{ sessionId: string; answer: string }>;
  /** Attaches to session `sessionId`'s sideband; resolves once the socket is open. */
  attach(sessionId: string, events: SidebandEvents): Promise<Sideband>;
}

const Created = z.object({ session: z.object({ id: z.string().min(1) }), transport: z.object({ sdp: z.string().min(1) }) });
const ApiError = z.object({ error: z.object({ message: z.string() }) });
const Event = z.object({ type: z.string() }).passthrough();

/** The project key, or null when the host has none (live calls then fall back to the local call). */
export function openAiKey(agentHome: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env["OPENAI_API_KEY"]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  if (agentHome === null) return null;
  const file = join(agentHome, "secrets", "openai.env");
  if (!existsSync(file)) return null;
  const line = readFileSync(file, "utf8")
    .split("\n")
    .map((row) => row.trim())
    .find((row) => /^(export\s+)?OPENAI_API_KEY=/.test(row));
  const value = line?.replace(/^(export\s+)?OPENAI_API_KEY=/, "").replace(/^["']|["']$/g, "").trim();
  return value === undefined || value === "" ? null : value;
}

/** The session object of a create request. */
export function sessionBody(config: LiveSessionConfig): Record<string, unknown> {
  return {
    model: LIVE_MODEL,
    instructions: config.instructions,
    audio: { output: { voice: config.voice } },
    delegation: { type: "client" },
    input: config.input.map((message) => ({
      type: "message",
      role: message.role,
      content: [{ type: message.role === "assistant" ? "output_text" : "input_text", text: message.text }],
    })),
  };
}

export class OpenAiLive implements LiveApi {
  constructor(private readonly key: string) {}

  async create(config: LiveSessionConfig, offer: string): Promise<{ sessionId: string; answer: string }> {
    const response = await fetch(API, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ session: sessionBody(config), transport: { type: "webrtc", sdp: offer } }),
      signal: AbortSignal.timeout(15_000),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = ApiError.safeParse(body);
      throw new Error(`GPT-Live ${String(response.status)}: ${error.success ? error.data.error.message : "no error body"}`);
    }
    const created = Created.parse(body);
    return { sessionId: created.session.id, answer: created.transport.sdp };
  }

  attach(sessionId: string, events: SidebandEvents): Promise<Sideband> {
    const { promise, resolve, reject } = Promise.withResolvers<Sideband>();
    // Bun's WebSocket takes request headers; the sideband authenticates like the create request.
    const socket = new WebSocket(`${SIDEBAND}/${encodeURIComponent(sessionId)}/attach`, { headers: { Authorization: `Bearer ${this.key}` } });
    let open = false;
    let closedByUs = false;
    socket.addEventListener("open", () => {
      open = true;
      resolve({
        send: (event) => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
        },
        close: () => {
          closedByUs = true;
          socket.close();
        },
      });
    });
    socket.addEventListener("message", (message) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(message.data));
      } catch {
        return;
      }
      const parsed = Event.safeParse(raw);
      if (parsed.success) events.event(parsed.data);
    });
    socket.addEventListener("close", (close) => {
      if (!open) {
        reject(new Error(`sideband refused (${String(close.code)} ${close.reason})`));
        return;
      }
      if (!closedByUs) events.closed(`sideband closed (${String(close.code)}${close.reason === "" ? "" : ` ${close.reason}`})`);
    });
    return promise;
  }
}

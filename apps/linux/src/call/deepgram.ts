// Deepgram Voice Agent session, host side: one scoped WebSocket per call, authenticated with the
// host's key (never sent to the phone). PCM16 in at 16 kHz, typed `AgentEvent`s out (binary frames
// are 24 kHz PCM16 speech): the phone's `call.*` rates, so nothing is resampled.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CALL_INPUT_RATE, CALL_OUTPUT_RATE } from "@relay/protocol";
import { type Cause, Context, Data, Duration, Effect, Layer, Queue, type Scope, Stream } from "effect";
import { z } from "zod";

const ENDPOINT = "wss://agent.deepgram.com/v1/agent/converse";
/** How long Deepgram has to apply `Settings` before the call falls back. */
export const SETTINGS_TIMEOUT = Duration.seconds(8);
/** Deepgram closes a session that hears nothing for a while; a call that sends no audio pings this often. */
export const KEEP_ALIVE = Duration.seconds(8);
// Managed models (no third-party key); picked by ear in the smoke.
const LISTEN_MODEL = "nova-3";
const THINK_MODEL = "gpt-4o-mini";
const SPEAK_MODEL = "aura-2-thalia-en";

/** The host's Deepgram key: `$DEEPGRAM_API_KEY`, else `<agentHome>/secrets/deepgram.env`; null when absent. */
export function deepgramKey(agentHome: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env["DEEPGRAM_API_KEY"]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  if (agentHome === null) return null;
  const file = join(agentHome, "secrets", "deepgram.env");
  if (!existsSync(file)) return null;
  const line = readFileSync(file, "utf8")
    .split("\n")
    .map((row) => row.trim())
    .find((row) => /^(export\s+)?DEEPGRAM_API_KEY=/.test(row));
  const value = line?.replace(/^(export\s+)?DEEPGRAM_API_KEY=/, "").replace(/^["']|["']$/g, "").trim();
  return value === undefined || value === "" ? null : value;
}

/** Why a session did not open or stopped. The message is ours or Deepgram's own description: never the key or a header. */
export class DeepgramError extends Data.TaggedError("DeepgramError")<{ readonly message: string }> {}

/** A function the agent may call; sent as is in `Settings` (`defer_until_eot` keeps it from firing before the turn is confirmed). */
export interface AgentFunction {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly defer_until_eot?: boolean;
}

export interface AgentConfig {
  readonly prompt: string;
  readonly greeting?: string;
  /** Earlier turns the agent starts with. */
  readonly history: readonly { readonly role: "user" | "assistant"; readonly content: string }[];
  readonly functions: readonly AgentFunction[];
}

export type AgentEvent =
  | { readonly t: "audio"; readonly pcm: Uint8Array }
  | { readonly t: "user-speaking" }
  | { readonly t: "agent-speaking" }
  | { readonly t: "agent-audio-done" }
  | { readonly t: "text"; readonly role: "user" | "assistant"; readonly content: string }
  | { readonly t: "function"; readonly id: string; readonly name: string; readonly arguments: string }
  | { readonly t: "function-cancelled"; readonly ids: readonly string[] }
  | { readonly t: "injection-refused" }
  | { readonly t: "warning"; readonly message: string }
  | { readonly t: "error"; readonly message: string }
  | { readonly t: "closed"; readonly reason: string };

export interface AgentSession {
  /** PCM16 LE mono at CALL_INPUT_RATE from the phone. */
  sendAudio(pcm: Uint8Array): void;
  /** A JSON command (`FunctionCallResponse`, `InjectAgentMessage`, ...). */
  sendJson(message: Readonly<Record<string, unknown>>): void;
  /** Every server frame; ends after `closed`. */
  readonly events: Stream.Stream<AgentEvent>;
}

export class DeepgramAgent extends Context.Service<
  DeepgramAgent,
  {
    /** Opens a session in the caller's scope; closing the scope closes the socket. */
    open(config: AgentConfig): Effect.Effect<AgentSession, DeepgramError, Scope.Scope>;
  }
>()("relay/call/DeepgramAgent") {}

/** The WebSocket members the session uses (Bun's `WebSocket` satisfies it). */
export interface AgentSocket {
  binaryType: "arraybuffer" | "nodebuffer" | "blob";
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: { readonly reason: string }) => void) | null;
  send(data: string | Uint8Array): void;
  close(): void;
}

export type ConnectAgent = (url: string, key: string) => AgentSocket;

/** Bun's WebSocket takes request headers; Deepgram authenticates with `Authorization: Token <key>`. */
const connectBun: ConnectAgent = (url, key) => new WebSocket(url, { headers: { Authorization: `Token ${key}` } }) as unknown as AgentSocket;

export function settingsMessage(config: AgentConfig): Record<string, unknown> {
  return {
    type: "Settings",
    audio: {
      input: { encoding: "linear16", sample_rate: CALL_INPUT_RATE },
      output: { encoding: "linear16", sample_rate: CALL_OUTPUT_RATE, container: "none" },
    },
    agent: {
      listen: { provider: { type: "deepgram", model: LISTEN_MODEL } },
      think: { provider: { type: "open_ai", model: THINK_MODEL }, prompt: config.prompt, functions: config.functions },
      speak: { provider: { type: "deepgram", model: SPEAK_MODEL } },
      ...(config.greeting === undefined ? {} : { greeting: config.greeting }),
      context: { messages: config.history.map((turn) => ({ type: "History", role: turn.role, content: turn.content })) },
    },
  };
}

const Frame = z.object({ type: z.string() }).passthrough();
const Text = z.object({ role: z.enum(["user", "assistant"]), content: z.string() });
const FunctionRequest = z.object({ functions: z.array(z.object({ id: z.string(), name: z.string(), arguments: z.string(), client_side: z.boolean() })) });
const FunctionCancelled = z.object({ functions: z.array(z.object({ id: z.string() })) });
const Problem = z.object({ code: z.string().optional(), description: z.string().optional() });

function problem(frame: unknown): string {
  const parsed = Problem.safeParse(frame);
  return parsed.success ? `${parsed.data.code ?? "unknown"}: ${parsed.data.description ?? ""}`.trim() : "unreadable";
}

/** The events a JSON frame carries; `SettingsApplied` and `Welcome` are the session's own and carry none. */
export function parseFrame(raw: string): AgentEvent[] {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  const frame = Frame.safeParse(json);
  if (!frame.success) return [];
  switch (frame.data.type) {
    case "UserStartedSpeaking":
      return [{ t: "user-speaking" }];
    case "AgentStartedSpeaking":
      return [{ t: "agent-speaking" }];
    case "AgentAudioDone":
      return [{ t: "agent-audio-done" }];
    case "InjectionRefused":
      return [{ t: "injection-refused" }];
    case "ConversationText": {
      const text = Text.safeParse(frame.data);
      return text.success ? [{ t: "text", role: text.data.role, content: text.data.content }] : [];
    }
    case "FunctionCallRequest": {
      const request = FunctionRequest.safeParse(frame.data);
      return request.success
        ? request.data.functions.filter((fn) => fn.client_side).map((fn) => ({ t: "function", id: fn.id, name: fn.name, arguments: fn.arguments }))
        : [];
    }
    case "FunctionCallCancelled": {
      const cancelled = FunctionCancelled.safeParse(frame.data);
      return cancelled.success ? [{ t: "function-cancelled", ids: cancelled.data.functions.map((fn) => fn.id) }] : [];
    }
    case "Warning":
      return [{ t: "warning", message: problem(frame.data) }];
    case "Error":
      return [{ t: "error", message: problem(frame.data) }];
    default:
      return [];
  }
}

export function deepgramAgentLayer(key: string, connect: ConnectAgent = connectBun): Layer.Layer<DeepgramAgent> {
  return Layer.succeed(
    DeepgramAgent,
    DeepgramAgent.of({
      open: (config) =>
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<AgentEvent, Cause.Done>();
          const socket = yield* Effect.acquireRelease(
            Effect.sync(() => connect(ENDPOINT, key)),
            (open) =>
              Effect.sync(() => {
                open.onopen = open.onmessage = open.onerror = open.onclose = null;
                open.close();
                Queue.endUnsafe(events);
              }),
          );
          socket.binaryType = "arraybuffer";
          let applied = false;
          yield* Effect.callback<unknown, DeepgramError>((resume) => {
            socket.onopen = () => {
              socket.send(JSON.stringify(settingsMessage(config)));
            };
            socket.onmessage = ({ data }) => {
              const pcm = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null;
              if (pcm !== null) {
                Queue.offerUnsafe(events, { t: "audio", pcm });
                return;
              }
              if (typeof data !== "string") return;
              if (!applied && /"type"\s*:\s*"SettingsApplied"/.test(data)) {
                applied = true;
                resume(Effect.void);
                return;
              }
              for (const event of parseFrame(data)) {
                if (!applied && event.t === "error") resume(Effect.fail(new DeepgramError({ message: `Deepgram refused the session (${event.message})` })));
                Queue.offerUnsafe(events, event);
              }
            };
            socket.onerror = () => {
              if (!applied) resume(Effect.fail(new DeepgramError({ message: "Deepgram connection failed" })));
            };
            socket.onclose = ({ reason }) => {
              if (!applied) resume(Effect.fail(new DeepgramError({ message: "Deepgram closed the connection before the session started" })));
              Queue.offerUnsafe(events, { t: "closed", reason });
              Queue.endUnsafe(events);
            };
          }).pipe(
            Effect.timeoutOrElse({ duration: SETTINGS_TIMEOUT, orElse: () => Effect.fail(new DeepgramError({ message: "Deepgram did not start the session in time" })) }),
          );
          let sent = true;
          yield* Effect.forkScoped(Effect.forever(Effect.sleep(KEEP_ALIVE).pipe(Effect.andThen(Effect.sync(() => {
            if (!sent) socket.send(JSON.stringify({ type: "KeepAlive" }));
            sent = false;
          })))));
          return {
            sendAudio: (pcm) => {
              sent = true;
              socket.send(pcm);
            },
            sendJson: (message) => {
              sent = true;
              socket.send(JSON.stringify(message));
            },
            events: Stream.fromQueue(events),
          } satisfies AgentSession;
        }),
    }),
  );
}

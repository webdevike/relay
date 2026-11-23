import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";
import { CALL_INPUT_RATE, CALL_OUTPUT_RATE } from "@relay/protocol";
import {
  type AgentConfig,
  DeepgramAgent,
  deepgramAgentLayer,
  deepgramKey,
  KEEP_ALIVE,
  parseFrame,
  SETTINGS_TIMEOUT,
} from "../src/call/deepgram";
import { FakeSocket, type Server } from "./deepgram-fake";

const KEY = "dg-synthetic-key";
const config: AgentConfig = {
  prompt: "You are Nova.",
  greeting: "Hi.",
  history: [{ role: "user", content: "hello" }],
  functions: [{ name: "ask_assistant", description: "Ask", parameters: { type: "object", properties: {} }, defer_until_eot: true }],
};

function harness(server: Server): { socket: FakeSocket; connected: string[]; run: <A, E>(program: Effect.Effect<A, E, DeepgramAgent>) => Promise<A> } {
  const socket = new FakeSocket(server);
  const connected: string[] = [];
  const layer = deepgramAgentLayer(KEY, (url, key) => {
    connected.push(url, key);
    return socket;
  });
  return { socket, connected, run: (program) => Effect.runPromise(program.pipe(Effect.provide(layer), Effect.provide(TestClock.layer()))) };
}

describe("Deepgram agent session", () => {
  it("sends Settings first at the phone's rates, then streams typed events, and closes the socket once with the scope", async () => {
    const h = harness("applies");
    const events = await h.run(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* (yield* DeepgramAgent).open(config);
          h.socket.onmessage?.({ data: new Uint8Array([1, 2]).buffer });
          h.socket.emit({ type: "UserStartedSpeaking" });
          h.socket.emit({ type: "ConversationText", role: "user", content: "what time is it" });
          h.socket.emit({ type: "FunctionCallRequest", functions: [{ id: "f1", name: "ask_assistant", arguments: '{"question":"time"}', client_side: true }, { id: "f2", name: "end_call", arguments: "{}", client_side: false }] });
          session.sendAudio(new Uint8Array([9]));
          session.sendJson({ type: "InjectAgentMessage", message: "It is noon." });
          h.socket.onclose?.({ reason: "bye" });
          return yield* Stream.runCollect(session.events);
        }),
      ),
    );
    expect(h.socket.sent[0]).toBeTypeOf("string");
    const settings = JSON.parse(h.socket.sent[0] as string) as { type: string; audio: unknown; agent: { think: { prompt: string; functions: unknown[] }; context: { messages: unknown[] }; greeting: string } };
    expect(settings.type).toBe("Settings");
    expect(settings.audio).toEqual({ input: { encoding: "linear16", sample_rate: CALL_INPUT_RATE }, output: { encoding: "linear16", sample_rate: CALL_OUTPUT_RATE, container: "none" } });
    expect(settings.agent.think.functions).toEqual(config.functions);
    expect(settings.agent.context.messages).toEqual([{ type: "History", role: "user", content: "hello" }]);
    expect(events).toEqual([
      { t: "audio", pcm: new Uint8Array([1, 2]) },
      { t: "user-speaking" },
      { t: "text", role: "user", content: "what time is it" },
      { t: "function", id: "f1", name: "ask_assistant", arguments: '{"question":"time"}' },
      { t: "closed", reason: "bye" },
    ]);
    expect(h.socket.json().map((m) => m.type)).toEqual(["Settings", "InjectAgentMessage"]);
    expect(h.socket.closed).toBe(1);
    expect(h.connected[1]).toBe(KEY);
  });

  it("fails with a typed error when Deepgram refuses the settings, without the key in the message", async () => {
    const h = harness("errors");
    const error = await h.run(
      Effect.gen(function* () {
        const agent = yield* DeepgramAgent;
        return yield* Effect.flip(Effect.scoped(agent.open(config)));
      }),
    );
    expect(error).toMatchObject({ _tag: "DeepgramError" });
    expect(error.message).toBe("Deepgram refused the session (INVALID_SETTINGS: bad)");
    expect(error.message).not.toContain(KEY);
    expect(h.socket.closed).toBe(1);
  });

  it("times out when settings are never applied, and closes the socket", async () => {
    const h = harness("silent");
    const error = await h.run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.flip(Effect.scoped((yield* DeepgramAgent).open(config))));
        yield* TestClock.adjust(SETTINGS_TIMEOUT);
        return yield* Fiber.join(fiber);
      }),
    );
    expect(error.message).toBe("Deepgram did not start the session in time");
    expect(h.socket.closed).toBe(1);
  });

  it("pings KeepAlive only when nothing else was sent", async () => {
    const h = harness("applies");
    await h.run(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* (yield* DeepgramAgent).open(config);
          session.sendAudio(new Uint8Array([1]));
          yield* TestClock.adjust(KEEP_ALIVE);
          expect(h.socket.json().map((m) => m.type)).toEqual(["Settings"]);
          yield* TestClock.adjust(KEEP_ALIVE);
          expect(h.socket.json().map((m) => m.type)).toEqual(["Settings", "KeepAlive"]);
        }),
      ),
    );
  });
});

describe("Deepgram frames and key", () => {
  it("ignores frames it does not model and drops server-side function calls", () => {
    expect(parseFrame("not json")).toEqual([]);
    expect(parseFrame('{"type":"Welcome","request_id":"r"}')).toEqual([]);
    expect(parseFrame('{"type":"FunctionCallCancelled","functions":[{"id":"f1","name":"x"}]}')).toEqual([{ t: "function-cancelled", ids: ["f1"] }]);
    expect(parseFrame('{"type":"Warning","code":"W","description":"d"}')).toEqual([{ t: "warning", message: "W: d" }]);
  });

  it("reads the key from the environment, else the agent home's secrets file, else null", () => {
    const home = mkdtempSync(join(tmpdir(), "dg-home-"));
    expect(deepgramKey(home, {})).toBeNull();
    mkdirSync(join(home, "secrets"));
    writeFileSync(join(home, "secrets", "deepgram.env"), `# synthetic\nDEEPGRAM_API_KEY="from-file"\n`);
    expect(deepgramKey(home, {})).toBe("from-file");
    expect(deepgramKey(home, { DEEPGRAM_API_KEY: " from-env " })).toBe("from-env");
    expect(deepgramKey(null, {})).toBeNull();
  });
});

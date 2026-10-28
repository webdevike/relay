#!/usr/bin/env bun
// A stand-in host for testing a phone's live calls before the installed host has them: serves
// only the handshake and `live.*` on its own port, runs this branch's `LiveService` (the code the
// host runs) with a real OpenAI key, and reaches the assistant threads of the RUNNING host through
// `live-remote.ts`, so delegated turns land in the real threads. Phones authenticate with the
// secrets they paired with this Mac (the running host's device store); the welcome is empty.
//
//   bun test/live-standin.ts [--port 7899] [--host ws://127.0.0.1:7817/relay]
//
// Point a phone's live calls at ws://<this Mac>:<port>/relay (the LiveCall module's host list).

import { randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { encode, parseClientMessage, WS_PATH, type ServerMessage } from "@relay/protocol";
import { FileDeviceStore } from "../src/device-store";
import { openAiKey, OpenAiLive } from "../src/live/openai";
import { LiveService } from "../src/live/service";
import type { FrameSink } from "../src/seams";
import { systemClock } from "../src/session";
import { connectRemoteThread, type RemoteThread } from "./live-remote";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: "string", default: "7899" },
    host: { type: "string", default: "ws://127.0.0.1:7817/relay" },
    voice: { type: "string", default: "marin" },
  },
});
const key = openAiKey(process.env["RELAY_AGENT_HOME"] ?? join(process.env["HOME"] ?? "", "Eva"));
if (key === null) throw new Error("no OpenAI key ($OPENAI_API_KEY or ~/Eva/secrets/openai.env)");
const log = (line: string): void => {
  console.error(`${new Date().toISOString()} ${line}`);
};

const threads = new Map<string, RemoteThread>();
const live = new LiveService({
  thread: (agent) => threads.get(agent)?.thread,
  api: new OpenAiLive(key),
  voice: () => values.voice,
  clock: systemClock,
  log,
});
for (const agent of ["nova", "astra"]) {
  const remote = await connectRemoteThread(values.host, agent, "Live stand-in");
  remote.onChange = (change) => {
    live.observe(change);
  };
  threads.set(agent, remote);
}
const shutdown = (): void => {
  for (const remote of threads.values()) remote.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const devices = new FileDeviceStore();
interface Conn {
  deviceId: string | null;
  nonce: string | null;
  authed: boolean;
  sink: FrameSink;
}

const server = Bun.serve<Conn>({
  port: Number(values.port),
  fetch(request, srv) {
    if (new URL(request.url).pathname !== WS_PATH) return new Response("not found", { status: 404 });
    const conn: Conn = { deviceId: null, nonce: null, authed: false, sink: { send: () => undefined, close: () => undefined } };
    return srv.upgrade(request, { data: conn }) ? undefined : new Response("upgrade failed", { status: 400 });
  },
  websocket: {
    maxPayloadLength: 1024 * 1024,
    open(ws) {
      ws.data.sink = {
        send: (message: ServerMessage) => {
          ws.send(encode(message));
        },
        close: () => {
          ws.close();
        },
      };
    },
    message(ws, raw) {
      const conn = ws.data;
      const parsed = parseClientMessage(String(raw));
      if (!parsed.ok) {
        log(`bad frame: ${parsed.error}`);
        return;
      }
      const message = parsed.value;
      if (message.t === "hello") {
        if (devices.secret(message.deviceId) === null) {
          conn.sink.send({ t: "unpaired" });
          return;
        }
        conn.deviceId = message.deviceId;
        conn.nonce = randomBytes(32).toString("hex");
        conn.sink.send({ t: "challenge", nonce: conn.nonce });
        return;
      }
      if (message.t === "auth") {
        const secret = conn.deviceId === null ? null : devices.secret(conn.deviceId);
        if (secret === null || conn.nonce === null) return;
        const expected = Buffer.from(createHmac("sha256", secret).update(conn.nonce, "utf8").digest("hex"));
        const proof = Buffer.from(message.proof);
        if (expected.length !== proof.length || !timingSafeEqual(expected, proof)) {
          conn.sink.send({ t: "error", code: "auth_failed", message: "bad proof" });
          ws.close();
          return;
        }
        conn.authed = true;
        log(`device ${conn.deviceId ?? "?"} authenticated`);
        // The live link skips the welcome's contents; an empty state keeps this stand-in small.
        ws.send(JSON.stringify({ t: "welcome", state: {} }));
        return;
      }
      if (!conn.authed) return;
      if (message.t === "ping") conn.sink.send({ t: "pong", ts: message.ts, serverTs: Date.now() });
      else if (message.t === "live.start" || message.t === "live.end") live.receive(conn.sink, message);
    },
    close(ws) {
      live.drop(ws.data.sink);
    },
  },
});
log(`live stand-in on ws://0.0.0.0:${String(server.port)}${WS_PATH}, threads from ${values.host}`);

#!/usr/bin/env bun
// Checks a RUNNING host's live calls the way the phone uses them: a throwaway paired device sends
// `live.start` with the aiortc phone's SDP offer (live_phone.py), applies `live.answer`, speaks one
// question and prints every `live.state` and what the voice said. Exit 0 when the host delegated
// to the thread and went back to listening.
//
//   bun test/live-host-check.ts [--host ws://127.0.0.1:7817/relay] [--agent nova] [--ask "..."]

import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { encode, parseServerMessage, type ClientMessage } from "@relay/protocol";
import { FileDeviceStore } from "../src/device-store";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    host: { type: "string", default: "ws://127.0.0.1:7817/relay" },
    agent: { type: "string", default: "nova" },
    ask: { type: "string", default: "What's the weather like right now?" },
    python: { type: "string", default: "/tmp/live-e2e-venv/bin/python" },
  },
});
const dir = mkdtempSync(join(tmpdir(), "live-host-check-"));
Bun.spawnSync(["say", "-v", "Samantha", "-o", join(dir, "q.aiff"), values.ask]);
Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-i", join(dir, "q.aiff"), "-ar", "48000", "-ac", "1", "-sample_fmt", "s16", join(dir, "q.wav")]);

const t0 = Date.now();
const say = (line: string): void => {
  console.error(`+${String(Date.now() - t0)}ms ${line}`);
};
const deviceId = `live-check-${randomBytes(4).toString("hex")}`;
const secret = randomBytes(32);
const devices = new FileDeviceStore();
devices.save(secret, deviceId, "Live check");
const callId = `check-${randomBytes(3).toString("hex")}`;
const phone = Bun.spawn([values.python, join(import.meta.dir, "live_phone.py"), "--out", join(dir, "heard.wav")], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
const tell = (command: Record<string, unknown>): void => {
  void phone.stdin.write(`${JSON.stringify(command)}\n`);
  void phone.stdin.flush();
};
const socket = new WebSocket(values.host);
const send = (message: ClientMessage): void => {
  socket.send(encode(message));
};
const { promise: done, resolve: finish } = Promise.withResolvers<boolean>();
const seen = { thinking: false, offer: "" };

socket.onopen = () => {
  send({ t: "hello", v: 1, deviceId, deviceName: "Live check", platform: "ios" });
};
socket.onmessage = (event: MessageEvent<string>) => {
  const parsed = parseServerMessage(event.data);
  if (!parsed.ok) return;
  const message = parsed.value;
  if (message.t === "challenge") send({ t: "auth", proof: createHmac("sha256", secret).update(message.nonce, "utf8").digest("hex") });
  else if (message.t === "welcome") {
    void (async () => {
      while (seen.offer === "") await Bun.sleep(50);
      say("live.start");
      send({ t: "live.start", callId, agent: values.agent, sdp: seen.offer });
    })();
  } else if (message.t === "live.answer" && message.callId === callId) {
    say(`live.answer (session ${message.sessionId})`);
    tell({ t: "answer", sdp: message.sdp });
  } else if (message.t === "live.state" && message.callId === callId) {
    say(`live.state ${message.state}${message.text === undefined ? "" : ` "${message.text}"`}${message.error === undefined ? "" : ` error: ${message.error}`}`);
    if (message.state === "thinking") seen.thinking = true;
    if (message.state === "listening" && seen.thinking) setTimeout(() => finish(true), 8_000);
    if (message.state === "ended") finish(false);
  }
};

const decoder = new TextDecoder();
let buffer = "";
void (async () => {
  for await (const chunk of phone.stdout) {
    buffer += decoder.decode(chunk);
    for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
      const line = JSON.parse(buffer.slice(0, newline)) as { t: string; sdp?: string; event?: { type: string; delta?: string } };
      buffer = buffer.slice(newline + 1);
      if (line.t === "offer" && line.sdp !== undefined) seen.offer = line.sdp;
      else if (line.t === "event" && line.event?.type === "session.started") {
        say("phone: session.started; asking after the greeting");
        setTimeout(() => {
          tell({ t: "play", wav: join(dir, "q.wav"), name: "q" });
        }, 3_000);
      } else if (line.t === "event" && line.event?.type === "session.output_transcript.delta") say(`voice: ${line.event.delta ?? ""}`);
      else if (line.t === "played") say("phone finished asking");
    }
  }
})();
const timer = setTimeout(() => finish(false), 120_000);
const ok = await done;
clearTimeout(timer);
send({ t: "live.end", callId });
tell({ t: "close" });
await Bun.sleep(4_000);
phone.kill();
socket.close();
devices.forget(deviceId);
say(ok ? "OK: delegated and answered" : "FAILED");
process.exit(ok ? 0 : 1);

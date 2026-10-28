// An assistant thread on the RUNNING host, as a live call sees it (`LiveThread`), for the live test
// tools: they run this branch's live-call code without replacing the installed host. Connects as a
// throwaway paired device (written straight into this machine's device store, forgotten on
// `close`), follows the thread with `assistant.get` / `assistant.snapshot`, delivers turns with the
// `assistant.turn` command, and turns snapshots into the provider changes a call observes.
// Differences from the host's own wiring: replies come from snapshots, where the details marker is
// already folded into a paragraph break (a reply with details is said whole).

import { createHmac, randomBytes } from "node:crypto";
import { encode, parseServerMessage, type AgentSession, type AssistantSnapshot, type ClientMessage, type ServerMessage } from "@relay/protocol";
import { FileDeviceStore } from "../src/device-store";
import type { LiveThread } from "../src/live/call";
import type { AgentProviderChange } from "../src/seams";

export interface RemoteThread {
  readonly thread: LiveThread;
  /** Where the thread's provider changes go (a call's or a service's `observe`). */
  onChange: ((change: AgentProviderChange) => void) | null;
  /** Each turn delivered, when the host acked it. */
  onTurn: ((at: number) => void) | null;
  /** The thread's rows that arrived after connecting. */
  newRows(): { role: string; voice: boolean; text: string }[];
  close(): void;
}

export async function connectRemoteThread(host: string, agent: string, label: string): Promise<RemoteThread> {
  const deviceId = `${label}-${randomBytes(4).toString("hex")}`;
  const secret = randomBytes(32);
  const devices = new FileDeviceStore();
  devices.save(secret, deviceId, label);
  const socket = new WebSocket(host);
  const send = (message: ClientMessage): void => {
    socket.send(encode(message));
  };
  const acks = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  const { promise: welcomed, resolve: welcome } = Promise.withResolvers<undefined>();
  const { promise: firstSnapshot, resolve: gotSnapshot } = Promise.withResolvers<undefined>();
  /** Rows in the thread before connecting: never said. */
  const before = new Set<string>();
  const state: { snapshot: AssistantSnapshot | null } = { snapshot: null };

  const session = (): AgentSession | undefined => {
    const snapshot = state.snapshot;
    if (snapshot === null || snapshot.sessionId === "") return undefined;
    return { id: snapshot.sessionId, provider: "omp", title: agent, projectPath: "", status: snapshot.busy ? "working" : "idle", lastActivity: "", lastActivityAt: 0, canRespond: true, kind: "assistant", assistant: agent };
  };

  const remote: RemoteThread = {
    onChange: null,
    onTurn: null,
    thread: {
      id: agent,
      title: agent.charAt(0).toUpperCase() + agent.slice(1),
      session,
      turn: (text) => {
        const id = randomBytes(6).toString("hex");
        const { promise, resolve, reject } = Promise.withResolvers<undefined>();
        acks.set(id, {
          resolve: () => {
            resolve(undefined);
          },
          reject,
        });
        send({ t: "cmd", id, cmd: { kind: "assistant.turn", agent, text } });
        return promise.then(() => {
          remote.onTurn?.(Date.now());
        });
      },
      rows: () => Promise.resolve(state.snapshot?.messages ?? []),
    },
    newRows: () => (state.snapshot?.messages ?? []).filter((row) => !before.has(row.id)).map((row) => ({ role: row.role, voice: row.voice === true, text: row.text })),
    close: () => {
      socket.close();
      devices.forget(deviceId);
    },
  };

  const onHost = (message: ServerMessage): void => {
    if (message.t === "challenge") send({ t: "auth", proof: createHmac("sha256", secret).update(message.nonce, "utf8").digest("hex") });
    else if (message.t === "welcome") welcome(undefined);
    else if (message.t === "ack") acks.get(message.id)?.resolve();
    else if (message.t === "nack") acks.get(message.id)?.reject(new Error(`${message.error.code}: ${message.error.message}`));
    else if (message.t === "assistant.snapshot" && message.agent === agent) {
      const first = state.snapshot === null;
      const snapshot = message.snapshot;
      state.snapshot = snapshot;
      if (first) {
        for (const row of snapshot.messages) before.add(row.id);
        gotSnapshot(undefined);
        return;
      }
      const observe = remote.onChange;
      if (observe === null) return;
      observe({ kind: "sessions" });
      snapshot.messages.forEach((row, index) => {
        if (row.role !== "assistant" || before.has(row.id)) return;
        observe({ kind: "message", sessionId: snapshot.sessionId, id: row.id, text: row.text, streaming: snapshot.busy && index === snapshot.messages.length - 1 });
      });
    }
  };
  socket.onopen = () => {
    send({ t: "hello", v: 1, deviceId, deviceName: label, platform: "ios" });
  };
  socket.onmessage = (event: MessageEvent<string>) => {
    const parsed = parseServerMessage(event.data);
    if (parsed.ok) onHost(parsed.value);
  };
  await welcomed;
  send({ t: "assistant.get", agent });
  await firstSnapshot;
  return remote;
}

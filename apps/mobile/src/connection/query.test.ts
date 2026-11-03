import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@relay/protocol";
import { createQueryClient, createQueryFrameRouter, PendingQueries } from "./query";

const mac = { name: "Host", version: "0.2.50", accessibilityGranted: true, agentsAvailable: true };
const welcome = (features?: string[]): ServerMessage => ({ t: "welcome", state: { mac, agents: { rev: 0, sessions: [] } }, ...(features ? { features } : {}) });

describe("live widget queries over the connection", () => {
  let pending: PendingQueries;
  let queries: boolean;
  let route: (message: ServerMessage) => void;
  let sent: { rid: string; tool: string; args: Record<string, unknown> }[];
  let connected: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    pending = new PendingQueries(1000);
    queries = false;
    route = createQueryFrameRouter((on) => (queries = on), pending);
    sent = [];
    connected = true;
  });
  afterEach(() => vi.useRealTimers());

  const client = () =>
    createQueryClient(pending, (rid, tool, args) => {
      if (!connected || !queries) return false;
      sent.push({ rid, tool, args });
      return true;
    });

  it("only offers queries on a host whose welcome says so", () => {
    route(welcome());
    expect(queries).toBe(false);
    route(welcome(["query"]));
    expect(queries).toBe(true);
    route(welcome(["something-else"]));
    expect(queries).toBe(false);
  });

  it("sends query.req and resolves with the matching query.res", async () => {
    route(welcome(["query"]));
    const answer = client().run("work_items", { limit: 5 });
    expect(sent).toEqual([{ rid: expect.any(String), tool: "work_items", args: { limit: 5 } }]);
    route({ t: "query.res", rid: "someone-else", ok: true, data: 1 });
    route({ t: "query.res", rid: sent[0]!.rid, ok: true, data: { total: 4 } });
    await expect(answer).resolves.toEqual({ total: 4 });
  });

  it("rejects with the host's reason, on a timeout, offline, and on an older host without sending", async () => {
    route(welcome(["query"]));
    const refused = client().run("jobs", { nope: 1 });
    route({ t: "query.res", rid: sent[0]!.rid, ok: false, error: "jobs args: unknown key" });
    await expect(refused).rejects.toThrow("jobs args: unknown key");

    const silent = client().run("jobs", {});
    vi.advanceTimersByTime(1000);
    await expect(silent).rejects.toThrow("Your Mac did not answer.");

    connected = false;
    await expect(client().run("jobs", {})).rejects.toThrow("Not connected to your Mac.");

    connected = true;
    route(welcome());
    const before = sent.length;
    await expect(client().run("jobs", {})).rejects.toThrow("Not connected to your Mac.");
    expect(sent).toHaveLength(before);
  });

  it("fails what is in flight when the connection goes", async () => {
    route(welcome(["query"]));
    const inFlight = client().run("relay_sessions", {});
    pending.cancelAll();
    await expect(inFlight).rejects.toThrow("Disconnected.");
  });
});

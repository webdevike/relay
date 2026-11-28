import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { HostConfig } from "../src/host-config";
import { RateLimited } from "../src/tickets/budget";
import { hostTickets } from "../src/tickets/service";

const config = (features: Record<string, boolean>): HostConfig => ({ features }) as unknown as HostConfig;

/** `hostTickets` as `serve` calls it, with a fetch and gh that record any call. */
function wire(cfg: HostConfig | null, env: Record<string, string> = {}) {
  const fetch = vi.fn(() => Promise.reject(new Error("no network in tests")));
  const run = vi.fn(() => Promise.reject(new Error("no gh in tests")));
  const dir = mkdtempSync(join(tmpdir(), "relay-tickets-wiring-"));
  const wiring = hostTickets(cfg, env, { dir, linearKey: () => "lin_api_test", gh: "gh", run, fetch, log: () => undefined });
  return { wiring, fetch, run };
}

describe("hostTickets (serve's construction path)", () => {
  it("with no host.json: no tickets service and Reviews gets no budgets (unpaced, as without tickets)", () => {
    const { wiring, fetch, run } = wire(null);
    expect(wiring).toEqual({ tickets: null, reviewsBudgets: null });
    expect(fetch).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("with features.tickets and ticketsWrites explicitly false: the same as absent", () => {
    expect(wire(config({ tickets: false, ticketsWrites: false })).wiring).toEqual({ tickets: null, reviewsBudgets: null });
    expect(wire(config({ ticketsWrites: true })).wiring).toEqual({ tickets: null, reviewsBudgets: null });
  });

  it("read-only (tickets on, writes off) shares budgets with Reviews and keeps the gate closed", () => {
    const { wiring, fetch, run } = wire(config({ tickets: true }));
    expect(wiring.tickets?.writes).toBe(false);
    expect(wiring.reviewsBudgets).not.toBeNull();
    // Building it calls nobody; the sync starts only with start().
    expect(fetch).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("dry run keeps the gate closed even with ticketsWrites; without it the gate opens", () => {
    expect(wire(config({ tickets: true, ticketsWrites: true }), { RELAY_REVIEWS_DRY_RUN: "1" }).wiring.tickets?.writes).toBe(false);
    expect(wire(config({ tickets: true, ticketsWrites: true })).wiring.tickets?.writes).toBe(true);
  });

  it("keeps a reserve the sync's background lane can't spend, for Reviews and writes", () => {
    const budgets = wire(config({ tickets: true })).wiring.reviewsBudgets;
    if (budgets === null) throw new Error("expected budgets");
    for (const [budget, reserve] of [
      [budgets.linear, 10],
      [budgets.github, 15],
    ] as const) {
      let synced = 0;
      for (;;) {
        try {
          budget.background.take();
          synced++;
        } catch (error) {
          expect(error).toBeInstanceOf(RateLimited);
          break;
        }
      }
      expect(synced).toBeGreaterThan(0);
      for (let i = 0; i < reserve; i++) budget.take();
      expect(() => budget.take()).toThrow(RateLimited);
    }
  });
});

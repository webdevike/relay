// Remote control (@relay/protocol CONTROL_FEATURE): the Relay Desktops that said `control.presence`,
// and agents' requests forwarded to one of them as `control.req`, answered by its `control.res`.
// "active" is the desktop Isaac used last (its `idleMs` on this host's clock, so the Macs' clocks
// never meet); with no input heard anywhere, the desktop on this Mac. Requests come only from
// processes on this Mac (`control/http.ts`); a device never asks another one anything.

import { randomBytes } from "node:crypto";
import type { ControlDevice, ControlPresence, ControlRequest, ControlResult } from "@relay/protocol";
import type { ControlClient, ControlRelaying, FrameSink } from "../seams";
import type { SessionClock } from "../session";

/** Isaac has 60 s to approve a destructive action in the app, and the page 15 s to answer. */
export const CONTROL_TIMEOUT_MS = 90_000;

interface Desktop {
  readonly sink: FrameSink;
  readonly id: string;
  name: string;
  instance: string;
  local: boolean;
  lastInputAt: number | null;
  page: string | null;
  focused: boolean;
  readonly connectedAt: number;
}

interface Pending {
  readonly sink: FrameSink;
  readonly finish: (result: ControlResult) => void;
}

/** Which desktop ran a request: echoed to the agent so it can say where it acted. */
export interface ControlAnswer {
  readonly result: ControlResult;
  readonly device: { readonly id: string; readonly name: string } | null;
}

const fail = (code: string, message: string): ControlResult => ({ ok: false, code, message });

export class ControlRelay implements ControlRelaying {
  private readonly desktops = new Map<FrameSink, Desktop>();
  private readonly pending = new Map<string, Pending>();

  constructor(
    /** The bearer token agents on this Mac read from serve.json (0600). */
    readonly token: string,
    private readonly clock: SessionClock,
    private readonly log: (line: string) => void,
    private readonly timeoutMs = CONTROL_TIMEOUT_MS,
  ) {}

  presence(client: ControlClient, p: ControlPresence): void {
    const now = this.clock.now();
    const known = this.desktops.get(client.sink);
    const lastInputAt = p.idleMs === null ? (known?.lastInputAt ?? null) : now - p.idleMs;
    const desktop: Desktop = {
      sink: client.sink,
      id: p.instance === "stable" ? client.device : `${client.device}:${p.instance}`,
      name: p.name,
      instance: p.instance,
      local: client.loopback && !p.remote,
      lastInputAt,
      page: p.page,
      focused: p.focused,
      connectedAt: known?.connectedAt ?? now,
    };
    if (known === undefined) this.log(`control: ${desktop.name} (${desktop.id}${desktop.local ? ", this Mac" : ""}) can be driven`);
    this.desktops.set(client.sink, desktop);
  }

  result(sink: FrameSink, rid: string, result: ControlResult): void {
    const waiting = this.pending.get(rid);
    // Only the socket the request went to answers it.
    if (waiting?.sink !== sink) return;
    waiting.finish(result);
  }

  drop(sink: FrameSink): void {
    if (!this.desktops.delete(sink)) return;
    for (const waiting of [...this.pending.values()]) {
      if (waiting.sink === sink) waiting.finish(fail("device-gone", "The desktop disconnected before it answered"));
    }
  }

  /** Every desktop that can be driven, the active one first, then by last input. */
  devices(): ControlDevice[] {
    const active = this.pick("active");
    const order = (a: Desktop, b: Desktop): number =>
      Number(b === active) - Number(a === active) || (b.lastInputAt ?? 0) - (a.lastInputAt ?? 0) || b.connectedAt - a.connectedAt;
    return [...this.desktops.values()].sort(order).map((d) => ({
      id: d.id,
      name: d.name,
      instance: d.instance,
      local: d.local,
      lastInputAt: d.lastInputAt,
      page: d.page,
      focused: d.focused,
      connectedAt: d.connectedAt,
      active: d === active,
    }));
  }

  /**
   * The desktop `target` names: "active" (most recent input; none heard: this Mac's, else the
   * newest connection), else an id or a name (case-insensitive), the most recently used on a tie.
   */
  pick(target: string): Desktop | null {
    const all = [...this.desktops.values()];
    const matches = target === "active" ? all : all.filter((d) => d.id === target || d.name.toLowerCase() === target.toLowerCase());
    let best: Desktop | null = null;
    for (const d of matches) {
      if (best === null) best = d;
      else if (rank(d) !== rank(best)) best = rank(d) > rank(best) ? d : best;
      else if (d.local !== best.local) best = d.local ? d : best;
      else if (d.connectedAt > best.connectedAt) best = d;
    }
    return best;
  }

  /** Runs one action on the desktop `request.target` names; never rejects. */
  run(request: ControlRequest): Promise<ControlAnswer> {
    const desktop = this.pick(request.target);
    if (desktop === null) {
      const known = [...this.desktops.values()].map((d) => d.id).join(", ");
      return Promise.resolve({
        result: fail("no-device", request.target === "active" ? "No Relay Desktop is connected to this host" : `No desktop ${request.target}; connected: ${known || "none"}`),
        device: null,
      });
    }
    const device = { id: desktop.id, name: desktop.name };
    const rid = `ctl-${randomBytes(8).toString("hex")}`;
    const { promise, resolve } = Promise.withResolvers<ControlAnswer>();
    const cancel = this.clock.after(this.timeoutMs, () => {
      finish(fail("device-timeout", `${desktop.name} did not answer in ${String(Math.round(this.timeoutMs / 1000))} s`));
    });
    const finish = (result: ControlResult): void => {
      if (!this.pending.delete(rid)) return;
      cancel();
      resolve({ result, device });
    };
    this.pending.set(rid, { sink: desktop.sink, finish });
    desktop.sink.send({
      t: "control.req",
      rid,
      action: request.action,
      ...(request.params === undefined ? {} : { params: request.params }),
      ...(request.confirm === undefined ? {} : { confirm: request.confirm }),
      ...(request.scope === undefined ? {} : { scope: request.scope }),
    });
    return promise;
  }
}

const rank = (d: Desktop): number => d.lastInputAt ?? Number.NEGATIVE_INFINITY;

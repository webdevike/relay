// Rooms over Relay Host (@relay/protocol ROOMS_FEATURE): Relay Desktops run the rooms and send
// them here (`rooms.sync`, `rooms.upsert`); phones read them (`rooms.get`, then `rooms.room` on
// every change) and act on them (`rooms.cmd`, forwarded to the desktop that owns the room).
//
// A socket's role is set by the first rooms frame it sends: `rooms.sync`/`upsert`/`res` make it
// a desktop, `rooms.get`/`cmd` a phone. Phones never send desktop frames and the reverse; such
// frames are dropped with a log. Only phones that asked (`rooms.get`) hear room changes.

import { randomBytes } from "node:crypto";
import { MAX_ROOM_BYTES, MAX_ROOMS, type RoomsCmd, type RoomsResult, type RoomWireSchema } from "@relay/protocol";
import type { z } from "zod";
import type { FrameSink } from "../seams";
import type { SessionClock } from "../session";

/** Image ops render and encode on the desktop; every op gets this long to answer. */
export const ROOMS_TIMEOUT_MS = 60_000;

export type HostRoom = z.output<typeof RoomWireSchema>;

interface Desktop {
  readonly rooms: Map<string, HostRoom>;
  /** Host clock time of its last rooms frame: the fallback for "active". */
  usedAt: number;
}

interface Pending {
  readonly desktop: FrameSink;
  readonly phone: FrameSink;
  readonly rid: string;
  readonly cancel: () => void;
}

export interface RoomsRelaying {
  sync(sink: FrameSink, rooms: readonly HostRoom[]): void;
  upsert(sink: FrameSink, room: HostRoom): void;
  result(sink: FrameSink, rid: string, result: RoomsResult): void;
  get(sink: FrameSink): void;
  cmd(sink: FrameSink, rid: string, cmd: RoomsCmd): void;
  drop(sink: FrameSink): void;
}

const fail = (code: string, message: string): RoomsResult => ({ ok: false, code, message });

export class RoomsRelay implements RoomsRelaying {
  private readonly desktops = new Map<FrameSink, Desktop>();
  private readonly phones = new Set<FrameSink>();
  /** Sockets that sent a phone frame; their desktop frames are refused. */
  private readonly phoneSockets = new WeakSet<FrameSink>();
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly clock: SessionClock,
    private readonly log: (line: string) => void,
    /** The desktop remote control calls active (see ControlRelay.pick), if any. */
    private readonly active: () => FrameSink | null = () => null,
    private readonly timeoutMs = ROOMS_TIMEOUT_MS,
  ) {}

  sync(sink: FrameSink, rooms: readonly HostRoom[]): void {
    const desktop = this.desktop(sink, "rooms.sync");
    if (desktop === null) return;
    desktop.rooms.clear();
    for (const room of rooms.slice(0, MAX_ROOMS)) {
      if (this.fits(room)) desktop.rooms.set(room.id, room);
    }
    this.sendState();
  }

  upsert(sink: FrameSink, room: HostRoom): void {
    const desktop = this.desktop(sink, "rooms.upsert");
    if (desktop === null || !this.fits(room)) return;
    if (!desktop.rooms.has(room.id) && desktop.rooms.size >= MAX_ROOMS) {
      // Keep the newest: drop its oldest room to make space.
      const oldest = [...desktop.rooms.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
      if (oldest !== undefined) desktop.rooms.delete(oldest.id);
    }
    desktop.rooms.set(room.id, room);
    for (const phone of this.phones) phone.send({ t: "rooms.room", room });
  }

  result(sink: FrameSink, rid: string, result: RoomsResult): void {
    if (this.desktop(sink, "rooms.res") === null) return;
    const waiting = this.pending.get(rid);
    // Only the desktop the command went to answers it.
    if (waiting?.desktop !== sink) return;
    this.finish(rid, result);
  }

  get(sink: FrameSink): void {
    if (!this.phone(sink, "rooms.get")) return;
    this.phones.add(sink);
    sink.send({ t: "rooms.state", rooms: this.all() });
  }

  cmd(sink: FrameSink, rid: string, cmd: RoomsCmd): void {
    if (!this.phone(sink, "rooms.cmd")) return;
    const desktop = cmd.op === "create" ? this.pickActive() : this.owner(cmd.roomId);
    if (desktop === null) {
      const anyDesktop = this.desktops.size > 0;
      sink.send({
        t: "rooms.res",
        rid,
        result: anyDesktop && cmd.op !== "create" ? fail("no-room", "That room is not open on any Mac") : fail("no-desktop", "Open Relay on your Mac to use Rooms"),
      });
      return;
    }
    const hostRid = `room-${randomBytes(8).toString("hex")}`;
    const cancel = this.clock.after(this.timeoutMs, () => {
      this.finish(hostRid, fail("timeout", "Your Mac did not answer in time"));
    });
    this.pending.set(hostRid, { desktop, phone: sink, rid, cancel });
    desktop.send({ t: "rooms.cmd", rid: hostRid, cmd });
  }

  drop(sink: FrameSink): void {
    this.phones.delete(sink);
    for (const [hostRid, waiting] of [...this.pending]) {
      if (waiting.phone === sink) {
        waiting.cancel();
        this.pending.delete(hostRid);
      } else if (waiting.desktop === sink) this.finish(hostRid, fail("device-gone", "Your Mac disconnected before it answered"));
    }
    if (this.desktops.delete(sink)) this.sendState();
  }

  /** Every room of every connected desktop, newest first. */
  private all(): HostRoom[] {
    const rooms: HostRoom[] = [];
    for (const d of this.desktops.values()) rooms.push(...d.rooms.values());
    return rooms.sort((a, b) => b.startedAt - a.startedAt);
  }

  private sendState(): void {
    if (this.phones.size === 0) return;
    const rooms = this.all();
    for (const phone of this.phones) phone.send({ t: "rooms.state", rooms });
  }

  private finish(hostRid: string, result: RoomsResult): void {
    const waiting = this.pending.get(hostRid);
    if (waiting === undefined) return;
    this.pending.delete(hostRid);
    waiting.cancel();
    waiting.phone.send({ t: "rooms.res", rid: waiting.rid, result });
  }

  private fits(room: HostRoom): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(room));
    if (bytes <= MAX_ROOM_BYTES) return true;
    this.log(`rooms: room ${room.id} is ${String(bytes)} bytes, over ${String(MAX_ROOM_BYTES)}; not relayed`);
    return false;
  }

  /** The desktop entry for a socket sending a desktop frame; null (logged) for a phone. */
  private desktop(sink: FrameSink, frame: string): Desktop | null {
    if (this.phoneSockets.has(sink)) {
      this.log(`rooms: ${frame} from a phone ignored`);
      return null;
    }
    let desktop = this.desktops.get(sink);
    if (desktop === undefined) {
      desktop = { rooms: new Map(), usedAt: this.clock.now() };
      this.desktops.set(sink, desktop);
    }
    desktop.usedAt = this.clock.now();
    return desktop;
  }

  private phone(sink: FrameSink, frame: string): boolean {
    if (this.desktops.has(sink)) {
      this.log(`rooms: ${frame} from a desktop ignored`);
      return false;
    }
    this.phoneSockets.add(sink);
    return true;
  }

  private owner(roomId: string): FrameSink | null {
    for (const [sink, d] of this.desktops) if (d.rooms.has(roomId)) return sink;
    return null;
  }

  private pickActive(): FrameSink | null {
    const active = this.active();
    if (active !== null && this.desktops.has(active)) return active;
    let best: [FrameSink, Desktop] | null = null;
    for (const entry of this.desktops) if (best === null || entry[1].usedAt >= best[1].usedAt) best = entry;
    return best?.[0] ?? null;
  }
}

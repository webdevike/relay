// Rooms over Relay Host: rooms run inside Relay Desktop (apps/desktop src/main/rooms); the host
// relays them to the phone. Only on hosts whose `welcome.features` has ROOMS_FEATURE.
//
//   desktop -> host   rooms.sync {rooms}         every room it runs, on connect and after a reconnect
//   desktop -> host   rooms.upsert {room}        one room changed (debounced on the desktop)
//   phone   -> host   rooms.get                  answered by rooms.state
//   host    -> phone  rooms.state {rooms}        every room of every connected desktop, newest first
//   host    -> phone  rooms.room {room}          one room changed
//   phone   -> host   rooms.cmd {rid, cmd}       forwarded as rooms.cmd to the desktop owning cmd.roomId
//                                                (create: the active desktop, see ControlDevice.active)
//   desktop -> host   rooms.res {rid, result}    forwarded to the phone that asked
//   host    -> phone  rooms.res {rid, result}    `no-desktop` when no rooms-capable desktop is connected
//
// A room's shape is Relay Desktop's RoomSchema (@evaos/contract rooms.ts). The host passes it through
// untouched (bounded size), so `RoomWire` is a TS mirror for typed reads on the phone; the desktop
// assigns its Room to RoomWire, which makes tsc catch drift.
import { z } from "zod";
import type {
  CouncilHarness,
  CouncilModelKey,
  CouncilProvider,
  CouncilRole,
  CouncilThinking,
  CouncilTurnKind,
} from "./rooms-council";

export const ROOMS_FEATURE = "rooms";
/**
 * A host that relays `rooms.cmd` pause / resume and rooms in the `paused` phase. Phones send those
 * only to such a host (an older one drops the socket on an unknown frame); a desktop on an older
 * host sends paused rooms as `resolved`.
 */
export const ROOMS_RESUME_FEATURE = "rooms.resume";
/**
 * A host that relays chat rooms (Assistants > Rooms on the desktop: `kind: "chat"`, the `idle`
 * phase, members with their own model and role). A desktop sends them only to such a host (an
 * older one drops the socket over the `idle` phase); the host sends them only to phones that ask
 * with `rooms.get {chat: true}`, so a phone that cannot draw them never sees one.
 */
export const ROOMS_CHAT_FEATURE = "rooms.chat";
/**
 * A host that relays Isaac's actions on a chat room's decision cards (`rooms.cmd` vote, callPoll,
 * reopenPoll, answerAsk, decide). The cards themselves ride on room frames, which every host passes
 * through, so a phone draws them on any host; it sends the actions only to a host with this
 * feature (an older one drops the socket on a cmd its schema does not know).
 */
export const ROOMS_DECIDE_FEATURE = "rooms.decide";
/** Largest room frame the host relays, in bytes of JSON. */
export const MAX_ROOM_BYTES = 2_000_000;
export const MAX_ROOMS = 24;

export type RoomStage = "brief" | "contract" | "plan" | "build" | "look" | "integrate" | "critique" | "judge" | "converge" | "deliver";
export type RoomWirePhase = "idle" | "open" | "wrapping" | "resolved" | "failed" | "paused";

export interface RoomWireRender { path: string; caption: string }
export interface RoomWireRoutingEntry {
  round: number; seat: string; model: CouncilModelKey; harness: CouncilHarness; role: CouncilRole; part?: string | undefined;
  kind: CouncilTurnKind; files: string[]; tokens: { input: number; output: number; cached: number }; usd: number; ms: number;
  criteria?: Record<string, number> | undefined;
}
export type RoomWireCard =
  | { type: "contract"; version: number; path: string; text: string }
  | { type: "parts"; round: number; parts: { part: string; agentId: string; branch?: "A" | "B" | undefined; status: "ok" | "failed" | "bounced"; render?: string | undefined; note: string }[] }
  | {
      type: "scorecard"; round: number;
      criteria: { id: string; name: string; owner: string; score: number; delta?: number | undefined }[];
      total: number; verdict: "continue" | "converged" | "plateau" | "cap" | "branch" | "stopped"; note: string;
      fixes: { part: string; text: string }[]; log: RoomWireRoutingEntry[];
    }
  | { type: "pause"; spent: number; cap: number; nextCap: number; answered?: "continue" | "wrap" | undefined }
  | { type: "ask"; askId: string; agentId: string; action: string; answered?: "allow" | "deny" | undefined }
  | {
      type: "deliverable"; total?: number | undefined; spent: number; minutes: number; workdir: string; record?: string | undefined; routingFile?: string | undefined;
      before: RoomWireRender[]; after: RoomWireRender[]; changes: string[]; dissent: string[];
      who: { agentId: string; part?: string | undefined; did: string; turns: number; usd: number; moved: string }[];
    }
  // A chat room's decision cards (Relay Desktop @evaos/contract rooms-decisions.ts); `id` is the
  // message that carries the card, the `cardId` of the actions below.
  | {
      type: "poll"; id: string; by: string; question: string; options: RoomWireOption[];
      votes: Record<string, string>; state: "open" | "called" | "reopened"; called?: { option: string; by: string } | undefined;
    }
  | { type: "proscons"; id: string; subject: string; pros: RoomWirePoint[]; cons: RoomWirePoint[] }
  | { type: "question"; id: string; by: string; text: string; sub?: string | undefined; answers: string[]; answered?: string | undefined }
  | {
      type: "decision"; id: string; by: string; title: string; why: string; agree: string[];
      dissent: { by: string; note?: string | undefined }[]; next?: { who?: string | undefined; text: string } | undefined;
      alternatives: RoomWireOption[]; poll?: string | undefined; option?: string | undefined;
      state: "proposed" | "accepted" | "overridden" | "reopened"; previous?: string | undefined;
    };
export interface RoomWireOption { id: string; label: string }
export interface RoomWirePoint { text: string; by: string[]; state: "agreed" | "disputed"; against?: string[] | undefined }
export interface RoomWireSeat {
  role: CouncilRole; modelKey: CouncilModelKey; harness: CouncilHarness; thinking: CouncilThinking;
  part?: string | undefined; branch?: "A" | "B" | undefined; override: boolean; worktree?: string | undefined;
  demoted?: boolean | undefined; joinedRound?: number | undefined;
}
export interface RoomWireAgent {
  id: string; name: string; title: string; role: string; brief: string; model: string;
  tools: "none" | "read-only" | "full"; color: string; failed?: boolean | undefined; seat?: RoomWireSeat | undefined;
}
export interface RoomWireMessage {
  id: string; author: string; text: string; ts: number; reactions: { emoji: string; by: string[] }[];
  kind: "message" | "summary" | "card"; mentions: string[];
  renders?: RoomWireRender[] | undefined; part?: string | undefined; card?: RoomWireCard | undefined;
}
export interface RoomWireCouncil {
  effort: number; routing: Partial<Record<CouncilRole, CouncilProvider>>; parts: string[]; stage: RoomStage;
  round: number; maxRounds: number; workdir: string; source: string; refs: string[]; renderCmd: string;
  contract?: { path: string; version: number } | undefined;
  rubric: { id: string; name: string; owner: string }[];
  scores: { round: number; total: number; criteria: Record<string, number> }[];
  spend: { usd: number; estimate: number; cap: number; byAgent: Record<string, number> };
  minutesEstimate: number; paused?: boolean | undefined; pauseRequested?: boolean | undefined; routingFile?: string | undefined;
}
/** A chat room's member: an assistant (`assistant`, its registry id) or a custom agent, on an exact omp model. */
export interface RoomWireMember {
  id: string; assistant?: string | undefined; name: string; model: string; thinking: string; role: string;
  instructions?: string | undefined; guest?: boolean | undefined;
}
export interface RoomWireChat {
  setup: {
    title?: string | undefined; template: string; members: RoomWireMember[]; effort: number; budget: number;
    folder?: string | undefined; refs: string[]; draft?: string | undefined;
  };
  rev: number;
  /** List price so far: the room's total and each member's. */
  spend: { usd: number; byMember: Record<string, number> };
}
export interface RoomWire {
  id: string; kind?: "council" | "chat" | undefined; title: string; prompt: string; agents: RoomWireAgent[]; messages: RoomWireMessage[];
  presence: Record<string, { state: "thinking" | "reading" | "typing"; detail?: string | undefined; since: number }>;
  phase: RoomWirePhase; rounds: number; judge?: { verdict: "continue" | "converged"; note: string; at: number } | undefined;
  error?: string | undefined; startedAt: number; resolvedAt?: number | undefined; file?: string | undefined;
  council?: RoomWireCouncil | undefined;
  chat?: RoomWireChat | undefined;
}

const nonEmpty = z.string().min(1);
const roomId = z.string().min(1).max(64);
/** A room on the wire: checked for its id and phase, the rest passes through (see RoomWire). */
export const RoomWireSchema = z
  .object({ id: roomId, title: z.string(), phase: z.enum(["idle", "open", "wrapping", "resolved", "failed", "paused"]), startedAt: z.number() })
  .passthrough();

export const RoomsRid = z.string().min(1).max(64);

const provider = z.enum(["anthropic", "openai"]);
const role = z.enum(["integrator", "builder", "look", "director", "critic", "researcher", "judge"]);
/** What the phone asks a desktop to do; mirrors Relay Desktop's rooms.* invoke channels. */
export const RoomsCmd = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("create"),
    prompt: z.string().min(1).max(4000),
    council: z.object({
      effort: z.number().int().min(1).max(6),
      source: z.string().min(1).max(1000),
      refs: z.array(z.string().min(1).max(1000)).max(12).optional(),
      renderCmd: z.string().min(1).max(1000).optional(),
      routing: z.record(role, provider).optional(),
    }),
  }),
  z.object({ op: z.literal("post"), roomId, text: z.string().min(1).max(4000) }),
  z.object({ op: z.literal("react"), roomId, messageId: nonEmpty, emoji: nonEmpty }),
  /** Stop at the end of the round the room is in (needs ROOMS_RESUME_FEATURE). */
  z.object({ op: z.literal("pause"), roomId }),
  /** Run a paused, wrapped or failed council room on from its next round (needs ROOMS_RESUME_FEATURE). */
  z.object({ op: z.literal("resume"), roomId }),
  z.object({ op: z.literal("stop"), roomId }),
  z.object({ op: z.literal("raise"), roomId }),
  z.object({ op: z.literal("budget"), roomId, choice: z.enum(["continue", "wrap"]) }),
  z.object({ op: z.literal("answer"), roomId, askId: z.string().min(1).max(64), allow: z.boolean() }),
  // A chat room's decision cards (needs ROOMS_DECIDE_FEATURE); `cardId` is the card's message id.
  z.object({ op: z.literal("vote"), roomId, cardId: z.string().min(1).max(64), option: z.string().min(1).max(64).nullable() }),
  z.object({ op: z.literal("callPoll"), roomId, cardId: z.string().min(1).max(64), option: z.string().min(1).max(64).optional() }),
  z.object({ op: z.literal("reopenPoll"), roomId, cardId: z.string().min(1).max(64) }),
  z.object({ op: z.literal("answerAsk"), roomId, cardId: z.string().min(1).max(64), answer: z.string().min(1).max(80) }),
  z.object({ op: z.literal("decide"), roomId, cardId: z.string().min(1).max(64), action: z.enum(["accept", "override", "reopen"]), option: z.string().min(1).max(64).optional() }),
  /** A render or reference image of the room, as a JPEG data URL at most `max` px on its long side. */
  z.object({ op: z.literal("image"), roomId, path: z.string().min(1).max(2000), max: z.number().int().min(64).max(2048).default(1024) }),
]);
export type RoomsCmd = z.infer<typeof RoomsCmd>;

export const RoomsResult = z.union([
  z.object({ ok: z.literal(true), value: z.unknown().optional() }),
  z.object({ ok: z.literal(false), code: z.string().min(1).max(64), message: z.string().max(4000) }),
]);
export type RoomsResult = z.infer<typeof RoomsResult>;

/** Frames a client sends (desktop: sync, upsert, res; phone: get, cmd). */
export const RoomsClientFrames = [
  z.object({ t: z.literal("rooms.sync"), rooms: z.array(RoomWireSchema).max(MAX_ROOMS) }),
  z.object({ t: z.literal("rooms.upsert"), room: RoomWireSchema }),
  z.object({ t: z.literal("rooms.res"), rid: RoomsRid, result: RoomsResult }),
  /** `chat`: the phone draws chat rooms too (ROOMS_CHAT_FEATURE); without it the host leaves them out. */
  z.object({ t: z.literal("rooms.get"), chat: z.boolean().optional() }),
  z.object({ t: z.literal("rooms.cmd"), rid: RoomsRid, cmd: RoomsCmd }),
] as const;

/** Frames the host sends (phone: state, room, res; desktop: cmd). */
export const RoomsServerFrames = [
  z.object({ t: z.literal("rooms.state"), rooms: z.array(RoomWireSchema).max(MAX_ROOMS * 4) }),
  z.object({ t: z.literal("rooms.room"), room: RoomWireSchema }),
  z.object({ t: z.literal("rooms.res"), rid: RoomsRid, result: RoomsResult }),
  z.object({ t: z.literal("rooms.cmd"), rid: RoomsRid, cmd: RoomsCmd }),
] as const;

/**
 * The pure rules behind the Rooms screens (tested): what a room's header, phase strip, spend meter
 * and seat list say, and how the new-room form becomes a `rooms.cmd create`. Every number and name
 * comes from @relay/protocol's rooms-council.ts; nothing is restated here.
 */
import {
  COUNCIL_DEFAULT_ROUTING,
  COUNCIL_MAX_EFFORT,
  COUNCIL_MODELS,
  COUNCIL_PAUSE_AT,
  COUNCIL_ROLES,
  COUNCIL_TARGET_SCORE,
  councilCast,
  councilLabel,
  councilNotch,
  type CouncilCast,
  type CouncilHarness,
  type CouncilModelKey,
  type CouncilProvider,
  type CouncilRole,
  type CouncilRouting,
  type CouncilThinking,
  type RoomStage,
  type RoomWire,
  type RoomWireAgent,
  type RoomWireCouncil,
  type RoomsCmd,
  type RoomsResult,
} from "@relay/protocol";

/** Whether the room is still working (a wrapping room is finishing its last round). */
export const roomLive = (room: RoomWire): boolean => room.phase === "open" || room.phase === "wrapping";

/** A seat as the dial and the room draw it, whether it comes from a cast (before Start) or a room. */
export interface SeatView {
  id: string;
  name: string;
  title: string;
  color: string;
  role: CouncilRole;
  model: CouncilModelKey;
  harness: CouncilHarness;
  thinking: CouncilThinking;
  part?: string | undefined;
  branch?: "A" | "B" | undefined;
  override: boolean;
}

export function seatsOfCast(cast: CouncilCast): SeatView[] {
  return cast.seats.map((s) => ({
    id: s.id, name: s.name, title: s.title, color: s.color, role: s.role, model: s.model, harness: s.harness,
    thinking: s.thinking, part: s.part, branch: s.branch, override: s.override,
  }));
}

/** The seats of a running room: its agents that carry a seat. */
export function seatsOfRoom(room: RoomWire): SeatView[] {
  return room.agents.flatMap((a): SeatView[] =>
    a.seat === undefined
      ? []
      : [{
          id: a.id, name: a.name, title: a.title, color: a.color, role: a.seat.role, model: a.seat.modelKey, harness: a.seat.harness,
          thinking: a.seat.thinking, part: a.seat.part, branch: a.seat.branch, override: a.seat.override,
        }],
  );
}

/** "Opus 5.5 · Claude Code", from a seat's model key and harness. */
export const modelLine = (s: Pick<SeatView, "model" | "harness">, harnessLabel: Record<CouncilHarness, string>): string =>
  `${COUNCIL_MODELS[s.model].name} · ${harnessLabel[s.harness]}`;

export const providerOf = (model: CouncilModelKey): CouncilProvider => COUNCIL_MODELS[model].provider;

/** The routing a room runs under: defaults with the room's overrides on top. */
export const routingOf = (council: Pick<RoomWireCouncil, "routing"> | undefined): CouncilRouting => ({
  ...COUNCIL_DEFAULT_ROUTING,
  ...(council?.routing ?? {}),
});

/** The dial's numbers for a room: its notch under its own routing. */
export const castOfRoom = (council: RoomWireCouncil): CouncilCast => councilCast(council.effort, council.routing);

/** "Team" for the list pill and the header chip; null for a debate room without a council. */
export const notchName = (room: RoomWire): string | null => (room.council === undefined ? null : councilNotch(room.council.effort).name);

/** The notch's full label ("Team · High") for the chip that opens the dial. */
export const notchLabel = (room: RoomWire): string | null => (room.council === undefined ? null : councilLabel(room.council.effort));

const STAGE_LABEL: Record<RoomStage, string> = {
  brief: "Brief", contract: "Contract", plan: "Plan", build: "Build", look: "Look", integrate: "Integrate",
  critique: "Critique", judge: "Judge", converge: "Converge", deliver: "Deliver",
};
export const stageLabel = (stage: RoomStage): string => STAGE_LABEL[stage];

/** Every stage in the order a room moves through them. */
const STAGE_ORDER: RoomStage[] = ["brief", "contract", "plan", "build", "look", "integrate", "critique", "judge", "converge", "deliver"];

export type StepState = "done" | "current" | "todo";
export interface PhaseStep { stage: RoomStage; label: string; state: StepState }

/**
 * The strip of stages this room goes through: Contract when the work is split, Plan when not, Look
 * when a look seat is in the room, Integrate when parts are merged. A finished room is all done.
 */
export function phaseSteps(room: RoomWire): PhaseStep[] {
  const council = room.council;
  if (council === undefined) return [];
  const cast = castOfRoom(council);
  const hasLook = cast.seats.some((s) => s.role === "look");
  const steps: RoomStage[] = ["brief", cast.split ? "contract" : "plan", "build"];
  if (hasLook) steps.push("look");
  if (cast.split) steps.push("integrate");
  steps.push("critique", "judge", "deliver");
  const at = STAGE_ORDER.indexOf(council.stage);
  const finished = room.phase === "resolved";
  return steps.map((stage) => {
    const index = STAGE_ORDER.indexOf(stage);
    const state: StepState = finished || index < at ? "done" : index === at ? "current" : "todo";
    return { stage, label: STAGE_LABEL[stage], state };
  });
}

export interface SpendView {
  usd: number;
  cap: number;
  estimate: number;
  /** Spent over the cap, 0..1. */
  fraction: number;
  /** The share of the bar that is the estimate, 0..1. */
  estimateAt: number;
  /** At 80 % of the cap (COUNCIL_PAUSE_AT): the meter turns amber. */
  warn: boolean;
}

export function spendView(council: RoomWireCouncil): SpendView {
  const { usd, cap, estimate } = council.spend;
  const fraction = cap > 0 ? Math.min(1, usd / cap) : 0;
  return { usd, cap, estimate, fraction, estimateAt: cap > 0 ? Math.min(1, estimate / cap) : 0, warn: cap > 0 && usd >= cap * COUNCIL_PAUSE_AT };
}

/** "Round 2 of 3 · Build" while a council runs, the phase otherwise. */
export function roomStatus(room: RoomWire): string {
  const council = room.council;
  if (room.phase === "failed") return "Failed";
  if (room.phase === "resolved") return "Done";
  if (council === undefined) return room.phase === "wrapping" ? "Wrapping up" : `Round ${String(room.rounds)}`;
  if (council.paused === true) return "Paused for your call";
  const stage = stageLabel(council.stage);
  return council.round > 0 ? `Round ${String(council.round)} of ${String(council.maxRounds)} · ${stage}` : stage;
}

/** Name, tint and seat of a message author: Isaac, an agent, the judge or the room itself. */
export interface AuthorView { name: string; color: string | undefined; agent: RoomWireAgent | undefined; mine: boolean }

export function authorOf(room: RoomWire, id: string): AuthorView {
  if (id === "isaac") return { name: "You", color: undefined, agent: undefined, mine: true };
  const agent = room.agents.find((a) => a.id === id);
  if (agent !== undefined) return { name: agent.name, color: agent.color, agent, mine: false };
  if (id === "judge") return { name: "Judge", color: undefined, agent: undefined, mine: false };
  return { name: "Room", color: undefined, agent: undefined, mine: false };
}

/** A score's bar tone: green once it reaches the target, plain otherwise. */
export const scoreMet = (score: number): boolean => score >= COUNCIL_TARGET_SCORE;

/** "+1.5" / "-0.5" / null for no change. */
export function deltaLabel(delta: number | undefined): string | null {
  if (delta === undefined || delta === 0) return null;
  return `${delta > 0 ? "+" : "-"}${String(Math.round(Math.abs(delta) * 10) / 10)}`;
}

/** The seat that holds `part` as builder, with a branch B builder after it. */
export const buildersOf = (seats: readonly SeatView[], part: string): SeatView[] =>
  seats.filter((s) => s.role === "builder" && s.part === part);
export const lookOf = (seats: readonly SeatView[], part: string): SeatView[] => seats.filter((s) => s.role === "look" && s.part === part);

export interface NewRoomDraft {
  prompt: string;
  source: string;
  /** One path per line. */
  refs: string;
  renderCmd: string;
  effort: number;
  routing: CouncilRouting;
}

export const EMPTY_ROUTING: CouncilRouting = { ...COUNCIL_DEFAULT_ROUTING };

/** Overrides only: the roles whose provider differs from the default, which is what the desktop wants. */
export function routingOverrides(routing: CouncilRouting): Partial<CouncilRouting> {
  const out: Partial<CouncilRouting> = {};
  for (const role of COUNCIL_ROLES) if (routing[role] !== COUNCIL_DEFAULT_ROUTING[role]) out[role] = routing[role];
  return out;
}

export type DraftResult = { ok: true; cmd: Extract<RoomsCmd, { op: "create" }> } | { ok: false; error: string };

/** The create command for a filled form, or what is missing. */
export function createCommand(draft: NewRoomDraft): DraftResult {
  const prompt = draft.prompt.trim();
  const source = draft.source.trim();
  if (prompt === "") return { ok: false, error: "Say what the room should make." };
  if (source === "") return { ok: false, error: "Give the source folder on your Mac." };
  const refs = draft.refs.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (refs.length > 12) return { ok: false, error: "At most 12 reference images." };
  const renderCmd = draft.renderCmd.trim();
  const overrides = routingOverrides(draft.routing);
  return {
    ok: true,
    cmd: {
      op: "create",
      prompt,
      council: {
        effort: Math.max(1, Math.min(COUNCIL_MAX_EFFORT, Math.round(draft.effort))),
        source,
        ...(refs.length > 0 ? { refs } : {}),
        ...(renderCmd === "" ? {} : { renderCmd }),
        ...(Object.keys(overrides).length > 0 ? { routing: overrides } : {}),
      },
    },
  };
}

/** The last path component, for a render's fallback caption. */
export const baseName = (path: string): string => path.split("/").filter((p) => p !== "").pop() ?? path;

/** The message to show for a command the desktop refused or never answered; null when it worked. */
export const commandError = (result: RoomsResult): string | null => (result.ok ? null : result.message === "" ? "Your Mac could not do that." : result.message);

/** The id of the room a `create` made: the answer's value is the room, or its id. */
export function createdRoomId(value: unknown): string | null {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "object" && value !== null && "id" in value && typeof value.id === "string") return value.id;
  return null;
}

/** The stop (1-based) nearest to `x` on a slider whose first stop is `inset` from the left and last `inset` from the right. */
export function stopAt(x: number, width: number, stops: number, inset: number): number {
  const span = width - inset * 2;
  if (span <= 0 || stops < 2) return 1;
  const raw = Math.round(((x - inset) / span) * (stops - 1));
  return Math.max(0, Math.min(stops - 1, raw)) + 1;
}

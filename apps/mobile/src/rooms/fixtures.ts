/**
 * Realistic Room objects for tests and the dev-only preview (`app/rooms/dev.tsx`): a Team room
 * mid-run (parts board, scorecard, a pause waiting on Isaac, an outward ask), a finished Council
 * room with its deliverable, and a plain debate room. Never read in a release build.
 */
import { COUNCIL_MODELS, councilCast, type RoomWire, type RoomWireAgent, type RoomWireCouncil, type RoomWireMessage, type RoomWireRoutingEntry } from "@relay/protocol";

const T0 = 1_762_700_000_000;
const min = (n: number): number => T0 + n * 60_000;

function agentsOf(effort: number): RoomWireAgent[] {
  return councilCast(effort).seats.map((s) => ({
    id: s.id, name: s.name, title: s.title, role: s.role, brief: "", model: COUNCIL_MODELS[s.model].omp, tools: "full" as const, color: s.color,
    seat: { role: s.role, modelKey: s.model, harness: s.harness, thinking: s.thinking, part: s.part, branch: s.branch, override: s.override },
  }));
}

function councilOf(effort: number, patch: Partial<RoomWireCouncil>): RoomWireCouncil {
  const cast = councilCast(effort);
  return {
    effort, routing: { integrator: "anthropic", builder: "anthropic", researcher: "anthropic", look: "openai", director: "openai", critic: "openai", judge: "openai" },
    parts: cast.parts, stage: "build", round: 1, maxRounds: cast.notch.rounds, workdir: "/Users/ike/Eva/work/rooms/maul-1", source: "/Users/ike/Eva/work/blender-learning/cel-face",
    refs: ["/Users/ike/Eva/work/blender-learning/cel-face/refs/ref3-lockdown-TARGET.webp"], renderCmd: "Blender -b --python build.py -- --quick",
    rubric: [
      { id: "sil", name: "Silhouette and proportions", owner: "Integrator" },
      { id: "face", name: "Face: horns, tattoo, eyes", owner: "Head" },
      { id: "body", name: "Body stripes follow muscle", owner: "Body" },
      { id: "hands", name: "Hands: wraps, grip", owner: "Hands" },
      { id: "cloth", name: "Cloth: sash knot, pant folds", owner: "Legs + pants" },
      { id: "cel", name: "Cel shading and line weight", owner: "Look" },
    ],
    scores: [], spend: { usd: 0, estimate: cast.cost, cap: cast.cap, byAgent: {} }, minutesEstimate: cast.minutes,
    ...patch,
  };
}

const RENDERS = { target: "/Users/ike/Eva/work/rooms/maul-1/renders/target.webp", before: "/Users/ike/Eva/work/rooms/maul-1/renders/before.png", r1: "/Users/ike/Eva/work/rooms/maul-1/renders/round1-full.png", head: "/Users/ike/Eva/work/rooms/maul-1/renders/head.png", body: "/Users/ike/Eva/work/rooms/maul-1/renders/body.png" };
export const FIXTURE_RENDERS = RENDERS;

const log = (round: number, seat: string, role: RoomWireRoutingEntry["role"], model: RoomWireRoutingEntry["model"], harness: RoomWireRoutingEntry["harness"], kind: RoomWireRoutingEntry["kind"], usd: number, part?: string): RoomWireRoutingEntry => ({
  round, seat, role, model, harness, kind, part, files: [], tokens: { input: 12_000, output: 6_000, cached: 60_000 }, usd, ms: 180_000,
});

const msg = (id: string, author: string, text: string, at: number, extra: Partial<RoomWireMessage> = {}): RoomWireMessage => ({
  id, author, text, ts: min(at), reactions: [], kind: "message", mentions: [], ...extra,
});

/** A Team room in round 2: parts board, scorecard, a pause card and an ask waiting. */
export function runningRoom(): RoomWire {
  const agents = agentsOf(3);
  return {
    id: "maul-1", title: "Make the Lockdown Maul match the target", prompt: "Make the Lockdown Maul render match the target art. Keep the Guilty Gear techniques in NOTES.md working.",
    agents, presence: { "builder-1": { state: "typing", since: min(41) }, "builder-2": { state: "reading", detail: "build.py", since: min(41) } },
    phase: "open", rounds: 2, startedAt: min(0),
    council: councilOf(3, {
      stage: "build", round: 2, paused: true, spend: { usd: 5.12, estimate: 4.2, cap: 6.3, byAgent: {} },
      scores: [{ round: 1, total: 5.4, criteria: {} }, { round: 2, total: 6.9, criteria: {} }],
    }),
    messages: [
      msg("m1", "isaac", "Make the Lockdown Maul render match the target art. Keep the Guilty Gear techniques in NOTES.md working.", 0),
      msg("m2", "integrator-1", "Split into two parts: head and hands, body and legs. Contract v1 is posted. Everything ends on the neck and waist rings, 1 unit is 1 m, origin between the feet.", 3, { part: "Whole" }),
      { id: "c1", author: "integrator-1", text: "", ts: min(4), reactions: [], kind: "card", mentions: [], card: { type: "contract", version: 1, path: "/Users/ike/Eva/work/rooms/maul-1/main/contract.md", text: "Scale: 1 unit = 1 m, figure 1.75 m, origin between the feet, +Y forward.\nSeams: neck ring r=0.09, wrist rings r=0.045, waist ring r=0.16.\nNaming: part_<name> collections, maul_<part>_* objects.\nPalette: skin #D9A47C, wrap #2B2B33, sash #B3261E.\nOne shared GG_Cel node group, no per-part shaders." } },
      msg("m3", "director-1", "Target look: heavy ink line, flat two-tone shadows, warm key from the left. Here is the paintover for the head.", 8, { renders: [{ path: RENDERS.target, caption: "Head paintover" }, { path: RENDERS.head, caption: "Head, round 1" }] }),
      { id: "c2", author: "integrator-1", text: "", ts: min(24), reactions: [], kind: "card", mentions: [], card: { type: "parts", round: 1, parts: [
        { part: "Head + hands", agentId: "builder-1", status: "ok", render: RENDERS.head, note: "Horns and tattoo in. Hands are blocky." },
        { part: "Body + legs", agentId: "builder-2", status: "bounced", render: RENDERS.body, note: "Waist ring is 0.18, contract says 0.16." },
      ] } },
      { id: "c3", author: "judge-1", text: "", ts: min(30), reactions: [], kind: "card", mentions: [], card: { type: "scorecard", round: 1, verdict: "continue", total: 6.9, note: "Silhouette is close. Cloth and cel line weight are the gap.",
        criteria: [
          { id: "sil", name: "Silhouette and proportions", owner: "Integrator", score: 8.2, delta: 1.4 },
          { id: "face", name: "Face: horns, tattoo, eyes", owner: "Head + hands", score: 7.4, delta: 0.8 },
          { id: "body", name: "Body stripes follow muscle", owner: "Body + legs", score: 6.5, delta: 1.1 },
          { id: "hands", name: "Hands: wraps, grip", owner: "Head + hands", score: 5.8, delta: -0.3 },
          { id: "cloth", name: "Cloth: sash knot, pant folds", owner: "Body + legs", score: 5.1 },
          { id: "cel", name: "Cel shading and line weight", owner: "Look", score: 8.4, delta: 0.5 },
        ],
        fixes: [{ part: "Head + hands", text: "Wrap the knuckles and open the grip by 15 degrees." }, { part: "Body + legs", text: "Fold the sash knot over the left hip, not the right." }],
        log: [log(1, "builder-1", "builder", "sonnet-5.5", "claude-code", "code", 0.61, "Head + hands"), log(1, "builder-2", "builder", "sonnet-5.5", "omp", "code", 0.48, "Body + legs"), log(1, "judge-1", "judge", "sol-6.1", "omp", "score", 0.09)] } },
      msg("m4", "builder-1", "Wrapping the knuckles and opening the grip. Params for the wraps are in parts/hands/params.json if you want to tune them.", 38, { part: "Head + hands" }),
      { id: "c4", author: "system", text: "", ts: min(40), reactions: [], kind: "card", mentions: [], card: { type: "pause", spent: 5.12, cap: 6.3, nextCap: 9.45 } },
      { id: "c5", author: "builder-2", text: "", ts: min(41), reactions: [], kind: "card", mentions: [], card: { type: "ask", askId: "a1", agentId: "builder-2", action: "git push origin eva/maul-legs" } },
    ],
  };
}

/** A finished Council room with its deliverable. */
export function doneRoom(): RoomWire {
  const agents = agentsOf(4);
  return {
    id: "maul-0", title: "Lockdown Maul, four parts", prompt: "Match the target.", agents, presence: {}, phase: "resolved", rounds: 4, startedAt: min(-300), resolvedAt: min(-230),
    council: councilOf(4, {
      stage: "deliver", round: 4, workdir: "/Users/ike/Eva/work/rooms/maul-0", spend: { usd: 10.84, estimate: 12.1, cap: 18.2, byAgent: {} },
      scores: [{ round: 4, total: 8.6, criteria: {} }],
    }),
    messages: [
      { id: "d1", author: "judge-1", text: "", ts: min(-231), reactions: [], kind: "card", mentions: [], card: { type: "deliverable", total: 8.6, spent: 10.84, minutes: 68, workdir: "/Users/ike/Eva/work/rooms/maul-0", routingFile: "memory/rooms/maul-0.routing.jsonl",
        before: [{ path: RENDERS.before, caption: "Front" }, { path: RENDERS.before, caption: "Three quarter" }],
        after: [{ path: RENDERS.r1, caption: "Front" }, { path: RENDERS.r1, caption: "Three quarter" }],
        changes: ["Horns reshaped to the target arc.", "Sash knot moved to the left hip.", "Line weight now 2.4 px at the shoulders."],
        dissent: ["Kenji: the pants folds still read flat from the side."],
        who: [
          { agentId: "integrator-1", did: "Cut build.py into parts and kept the seams welded.", turns: 9, usd: 2.9, moved: "silhouette +1.8" },
          { agentId: "builder-1", part: "Head", did: "Horns, tattoo, eyes.", turns: 6, usd: 2.1, moved: "face +2.2" },
          { agentId: "builder-2", part: "Body", did: "Muscle stripes and torso.", turns: 6, usd: 1.4, moved: "body +1.6" },
          { agentId: "judge-1", did: "Scored every round.", turns: 4, usd: 0.5, moved: "" },
        ] } },
    ],
  };
}

/** A plain debate room (no council): the old Rooms keep working. */
export function debateRoom(): RoomWire {
  return {
    id: "debate-1", title: "Should the phone get a Rooms tab?", prompt: "Should the phone get a Rooms tab?",
    agents: [{ id: "ada", name: "Ada", title: "PM", role: "pm", brief: "", model: "anthropic/claude-opus-5-5", tools: "read-only", color: "#7C9CFF" }],
    messages: [msg("x1", "isaac", "Should the phone get a Rooms tab?", 0), msg("x2", "ada", "Yes, as a Home row. A tab for something Isaac opens twice a day is too loud.", 1)],
    presence: {}, phase: "open", rounds: 1, startedAt: min(-900),
  };
}

export const FIXTURE_ROOMS: RoomWire[] = [runningRoom(), doneRoom(), debateRoom()];

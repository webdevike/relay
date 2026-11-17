import { describe, expect, it } from "vitest";
import { createActor, fromPromise, SimulatedClock } from "xstate";
import type { KeyMoment } from "@relay/protocol";
import {
  KEY_MOMENTS_TRIES,
  KEY_MOMENTS_WINDOW_MS,
  keyMomentsMachine,
  mergeMoments,
  momentText,
  type ExtractInput,
  type KeyMomentsInput,
  type MomentDraft,
  type MomentLine,
} from "../src/meetings/key-moments.machine";

const line = (id: string, startMs: number, text: string, speaker = "Todd"): MomentLine => ({
  id,
  startMs,
  speaker,
  text,
});
const draft = (l: MomentLine, kind: MomentDraft["kind"], text: string): MomentDraft => ({
  kind,
  atMs: l.startMs,
  lineId: l.id,
  speaker: l.speaker,
  text,
  shot: null,
});

/** The machine on a simulated clock with an extract stub the test settles by hand. */
function harness(input: KeyMomentsInput = {}) {
  const clock = new SimulatedClock();
  const calls: {
    input: ExtractInput;
    resolve: (d: MomentDraft[]) => void;
    reject: (e: Error) => void;
  }[] = [];
  const machine = keyMomentsMachine.provide({
    actors: {
      extract: fromPromise<readonly MomentDraft[], ExtractInput>(({ input: i }) => {
        const { promise, resolve, reject } = Promise.withResolvers<readonly MomentDraft[]>();
        calls.push({ input: i, resolve, reject });
        return promise;
      }),
    },
  });
  const actor = createActor(machine, { input, clock });
  actor.start();
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };
  const state = (): unknown => actor.getSnapshot().value;
  return { clock, calls, actor, flush, state };
}

describe("key moments machine", () => {
  it("gathers a window of lines, extracts them once it closes and keeps what it found", async () => {
    const h = harness();
    expect(h.state()).toEqual({ live: "idle" });
    const a = line("a", 1_000, "Let's ship it Tuesday.");
    const b = line("b", 5_000, "Isaac, can you send the numbers?");
    h.actor.send({ type: "transcript.lines", lines: [a] });
    expect(h.state()).toEqual({ live: "gathering" });
    h.clock.increment(20_000);
    h.actor.send({ type: "transcript.lines", lines: [b] });
    h.clock.increment(KEY_MOMENTS_WINDOW_MS - 20_000 - 1);
    expect(h.calls).toHaveLength(0);
    h.clock.increment(1);
    expect(h.state()).toEqual({ live: "extracting" });
    expect(h.calls[0]?.input.lines.map((l) => l.id)).toEqual(["a", "b"]);
    h.calls[0]?.resolve([
      draft(a, "decision", "Ship Tuesday"),
      draft(b, "ask", "Send Todd the numbers"),
    ]);
    await h.flush();
    expect(h.state()).toEqual({ live: "idle" });
    const ctx = h.actor.getSnapshot().context;
    expect(ctx.moments.map((m) => [m.id, m.kind, m.text])).toEqual([
      ["km0", "decision", "Ship Tuesday"],
      ["km1", "ask", "Send Todd the numbers"],
    ]);
    expect(ctx.through).toBe(5_000);
    expect(ctx.recent.map((l) => l.id)).toEqual(["a", "b"]);
    // The next window gets them as context, with the moments so far.
    const c = line("c", 60_000, "The build is green.");
    h.actor.send({ type: "transcript.lines", lines: [c] });
    h.clock.increment(KEY_MOMENTS_WINDOW_MS);
    expect(h.calls[1]?.input).toMatchObject({
      lines: [{ id: "c" }],
      context: [{ id: "a" }, { id: "b" }],
      moments: [{ id: "km0" }, { id: "km1" }],
    });
  });

  it("opens the next window for lines said during an extraction", async () => {
    const h = harness();
    h.actor.send({ type: "transcript.lines", lines: [line("a", 0, "one")] });
    h.clock.increment(KEY_MOMENTS_WINDOW_MS);
    h.actor.send({ type: "transcript.lines", lines: [line("b", 50_000, "two")] });
    h.calls[0]?.resolve([]);
    await h.flush();
    expect(h.state()).toEqual({ live: "gathering" });
    h.clock.increment(KEY_MOMENTS_WINDOW_MS);
    expect(h.calls[1]?.input.lines.map((l) => l.id)).toEqual(["b"]);
  });

  it("retries a failed extraction with backoff, then lets its lines go", async () => {
    const h = harness({ retryMs: 1_000 });
    h.actor.send({ type: "transcript.lines", lines: [line("a", 0, "one")] });
    h.clock.increment(KEY_MOMENTS_WINDOW_MS);
    for (let i = 0; i < KEY_MOMENTS_TRIES - 1; i += 1) {
      h.calls[i]?.reject(new Error("rate limited"));
      await h.flush();
      expect(h.state()).toEqual({ live: "backoff" });
      // 1 s, then 2 s.
      h.clock.increment(1_000 * 2 ** i - 1);
      expect(h.calls).toHaveLength(i + 1);
      h.clock.increment(1);
      expect(h.calls).toHaveLength(i + 2);
      expect(h.calls[i + 1]?.input.lines.map((l) => l.id)).toEqual(["a"]);
    }
    h.calls[KEY_MOMENTS_TRIES - 1]?.reject(new Error("still down"));
    await h.flush();
    expect(h.state()).toEqual({ live: "idle" });
    expect(h.actor.getSnapshot().context).toMatchObject({ inFlight: [], failures: 0, through: 0 });
  });

  it("runs one last extraction when the call ends and finishes with the moments", async () => {
    const h = harness();
    const a = line("a", 0, "We go with Postgres.");
    h.actor.send({ type: "transcript.lines", lines: [a] });
    h.actor.send({ type: "call.ended" });
    expect(h.state()).toEqual({ ending: "extracting" });
    expect(h.calls[0]?.input.lines.map((l) => l.id)).toEqual(["a"]);
    expect(h.actor.getSnapshot().can({ type: "transcript.lines", lines: [a] })).toBe(false);
    h.calls[0]?.resolve([draft(a, "decision", "Go with Postgres")]);
    await h.flush();
    expect(h.actor.getSnapshot().status).toBe("done");
    expect(h.actor.getSnapshot().output?.moments.map((m) => m.text)).toEqual(["Go with Postgres"]);
  });

  it("ends at once with nothing waiting, and takes an interrupted extraction's lines into the last one", async () => {
    const idle = harness();
    idle.actor.send({ type: "call.ended" });
    expect(idle.actor.getSnapshot().status).toBe("done");
    expect(idle.calls).toHaveLength(0);

    const h = harness();
    h.actor.send({ type: "transcript.lines", lines: [line("a", 0, "one")] });
    h.clock.increment(KEY_MOMENTS_WINDOW_MS);
    h.actor.send({ type: "transcript.lines", lines: [line("b", 50_000, "two")] });
    h.actor.send({ type: "call.ended" });
    expect(h.calls[1]?.input.lines.map((l) => l.id)).toEqual(["a", "b"]);
    // The first call's late answer goes nowhere.
    h.calls[0]?.resolve([draft(line("a", 0, "one"), "claim", "Stale")]);
    h.calls[1]?.resolve([]);
    await h.flush();
    expect(h.actor.getSnapshot().output?.moments).toEqual([]);
  });

  it("keeps moments from before a restart and names a renamed speaker", async () => {
    const kept: KeyMoment = {
      id: "km4",
      kind: "action",
      atMs: 1_000,
      lineId: "a",
      speaker: "Remote",
      text: "Bill fixes the build",
      shot: null,
    };
    const h = harness({ moments: [kept], through: 1_000 });
    h.actor.send({ type: "transcript.renamed", lines: [line("a", 1_000, "I'll fix it", "Bill")] });
    expect(h.actor.getSnapshot().context.moments[0]?.speaker).toBe("Bill");
    const b = line("b", 70_000, "Release is the 18th.");
    h.actor.send({ type: "transcript.lines", lines: [b] });
    h.clock.increment(KEY_MOMENTS_WINDOW_MS);
    h.calls[0]?.resolve([draft(b, "claim", "Release is the 18th")]);
    await h.flush();
    expect(h.actor.getSnapshot().context.moments.map((m) => m.id)).toEqual(["km4", "km5"]);
  });
});

describe("mergeMoments", () => {
  const a = line("a", 2_000, "x");
  const b = line("b", 1_000, "y");
  it("drops repeats, keeps order by time and caps the text", () => {
    const first = mergeMoments([], [draft(a, "decision", "Ship the release on Tuesday")]);
    expect(first.map((m) => m.id)).toEqual(["km0"]);
    // Same kind and much the same words; same line and kind; nothing new: the same array back.
    const same = mergeMoments(first, [
      draft(b, "decision", "ship the release Tuesday"),
      draft(a, "decision", "Something else entirely"),
    ]);
    expect(same).toBe(first);
    const more = mergeMoments(first, [
      draft(a, "claim", "Release is Tuesday"),
      draft(b, "action", `Bill fixes it \u2014 today ${"x".repeat(300)}`),
    ]);
    expect(more.map((m) => [m.id, m.atMs])).toEqual([
      ["km2", 1_000],
      ["km0", 2_000],
      ["km1", 2_000],
    ]);
    expect(more[0]?.text.startsWith("Bill fixes it, today")).toBe(true);
    expect(more[0]?.text.length).toBeLessThanOrEqual(160);
    expect(momentText("a \u2013 b\n c")).toBe("a - b c");
  });
});

import { describe, expect, it } from "vitest";
import type { AgentSession, AssistantMessage, GuestEntry } from "@relay/protocol";
import { consultPrefix, Consults, QUICK_MS, type ConsultThread } from "../src/assistant/consult";
import { AckFailure, type ConsultResult } from "../src/seams";
import type { SessionClock } from "../src/session";

class FakeClock implements SessionClock {
  private timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  current = 1_000;
  now(): number {
    return this.current;
  }
  after(ms: number, fn: () => void): () => void {
    const timer = { at: this.current + ms, fn, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }
  advance(ms: number): void {
    this.current += ms;
    const due = this.timers.filter((timer) => !timer.cancelled && timer.at <= this.current);
    this.timers = this.timers.filter((timer) => !due.includes(timer));
    for (const timer of due) timer.fn();
  }
}

/** Lets the consult's awaited posts and reads run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

type Status = AgentSession["status"];
type FakeThread = ConsultThread & { status: Status | null; rows: AssistantMessage[]; turns: string[] };

function fakeThread(id: string, title: string, status: Status | null): FakeThread {
  return {
    id,
    title,
    color: id === "penny" ? "#22aa66" : undefined,
    status,
    rows: [],
    turns: [],
    current() {
      return this.status === null ? undefined : { id: `${id}-1`, provider: "omp", title, projectPath: "/home/ike/Eva", status: this.status, lastActivity: "", lastActivityAt: 1, canRespond: true, kind: "assistant", assistant: id };
    },
    turn(text) {
      this.turns.push(text);
      return Promise.resolve();
    },
    settled() {
      return Promise.resolve(this.rows);
    },
  };
}

function harness(options: { bridge?: boolean } = {}) {
  const clock = new FakeClock();
  const nova = fakeThread("nova", "Nova", "working");
  const penny = fakeThread("penny", "Penny", "idle");
  const posts: { session: string; content: string; details: GuestEntry }[] = [];
  const consults = new Consults({
    threads: () => [nova, penny],
    post: (session, content, details) => {
      posts.push({ session, content, details });
      return Promise.resolve(options.bridge ?? true);
    },
    clock,
    log: () => undefined,
    human: () => "Isaac",
    newId: () => "w1",
  });
  const reply = (text: string, at = clock.now()): void => {
    penny.rows.push({ id: `r${String(penny.rows.length)}`, role: "assistant", text, at });
  };
  const kinds = (): string[] => posts.map((post) => (post.details.kind === "work" ? `work:${post.details.work?.state ?? ""}` : post.details.kind));
  return { clock, nova, penny, posts, consults, reply, kinds };
}

describe("consult", () => {
  it("brings the guest in, puts the question to it in its own thread, and posts a quick answer before it leaves", async () => {
    const { clock, nova, penny, posts, consults, reply, kinds } = harness();
    let result: ConsultResult | null = null;
    void consults.consult({ from: "nova", agent: "penny", question: "What does a 2TB USB4 SSD cost?" }).then((r) => (result = r));
    await settle();
    expect(penny.turns).toEqual([`${consultPrefix("Nova", "Isaac")}What does a 2TB USB4 SSD cost?`]);
    expect(penny.turns[0]).toMatch(/^\[Asked by Nova in Isaac's chat\] /);
    expect(posts[0]).toEqual({ session: "nova-1", content: "Penny joined the chat", details: { kind: "join", agent: { id: "penny", title: "Penny", color: "#22aa66" } } });
    // Penny works, then settles with her answer well inside the quick wait.
    penny.status = "working";
    consults.observe({ kind: "sessions" });
    clock.advance(4_000);
    reply("About $189 for the Acasis enclosure with a WD SN7100.\nPrices move weekly.");
    penny.status = "idle";
    consults.observe({ kind: "sessions" });
    await settle();
    expect(result).toEqual({ kind: "answer", text: "About $189 for the Acasis enclosure with a WD SN7100.\nPrices move weekly." });
    expect(kinds()).toEqual(["join", "say", "leave"]);
    expect(posts[1]?.details.text).toBe("About $189 for the Acasis enclosure with a WD SN7100.\nPrices move weekly.");
    expect(consults.open).toBe(0);
    expect(nova.turns).toEqual([]);
  });

  it("turns a slow answer into a work card that finishes once the asking chat is idle", async () => {
    const { clock, nova, penny, posts, consults, reply, kinds } = harness();
    const pending = consults.consult({ from: "nova", agent: "penny", question: "Find a 2TB USB4 SSD under $200" });
    await settle();
    penny.status = "working";
    clock.advance(2_000);
    reply("On it, I'll report back in my chat.");
    consults.observe({ kind: "conversation", sessionId: "penny-1", appended: [] });
    await settle();
    // Still working when the quick wait runs out: her first words, she leaves, the card goes in.
    clock.advance(QUICK_MS);
    await settle();
    expect(await pending).toEqual({ kind: "work", id: "w1", title: "Find a 2TB USB4 SSD under $200" });
    expect(kinds()).toEqual(["join", "say", "leave", "work:working"]);
    expect(posts[3]?.details.work).toEqual({ id: "w1", title: "Find a 2TB USB4 SSD under $200", state: "working", startedAt: 1_000, link: "agent:penny" });
    // She finishes while Nova is still in her turn: the card waits for Nova to be idle.
    clock.advance(100_000);
    reply("Acasis 40Gbps + WD SN7100 2TB · $189\nOrdered nothing yet.");
    penny.status = "idle";
    consults.observe({ kind: "sessions" });
    await settle();
    expect(kinds()).toHaveLength(4);
    nova.status = "idle";
    consults.observe({ kind: "sessions" });
    await settle();
    expect(kinds()).toEqual(["join", "say", "leave", "work:working", "work:done"]);
    expect(posts[4]?.details).toMatchObject({ text: "Acasis 40Gbps + WD SN7100 2TB · $189", work: { id: "w1", state: "done", startedAt: 1_000, endedAt: clock.now() } });
    expect(posts[4]?.content).toBe("Penny finished Find a 2TB USB4 SSD under $200: Acasis 40Gbps + WD SN7100 2TB · $189");
    expect(consults.open).toBe(0);
  });

  it("goes straight to a work card when the guest is already busy or the asker says --work", async () => {
    for (const setup of [{ busy: true, work: false }, { busy: false, work: true }]) {
      const { penny, consults, kinds } = harness();
      if (setup.busy) penny.status = "working";
      expect(await consults.consult({ from: "nova", agent: "penny", question: "Book the Tahoe cabin", work: setup.work })).toMatchObject({ kind: "work", title: "Book the Tahoe cabin" });
      expect(kinds()).toEqual(["join", "leave", "work:working"]);
    }
  });

  it("marks the card failed when the guest's session ends before it settles", async () => {
    const { nova, penny, posts, consults, kinds } = harness();
    nova.status = "idle";
    await consults.consult({ from: "nova", agent: "penny", question: "Compare the two quotes", work: true });
    penny.status = "working";
    consults.observe({ kind: "sessions" });
    await settle();
    penny.status = null;
    consults.observe({ kind: "sessions" });
    await settle();
    expect(kinds()).toEqual(["join", "leave", "work:working", "work:failed"]);
    expect(posts[3]?.details.text).toBe("Penny's session ended");
  });

  it("refuses before asking anyone when the asking chat's bridge predates guests", async () => {
    const { penny, consults } = harness({ bridge: false });
    const failed = await consults.consult({ from: "nova", agent: "penny", question: "Hi" }).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(AckFailure);
    expect((failed as AckFailure).error.code).toBe("agent_cannot_respond");
    expect(penny.turns).toEqual([]);
  });

  it("finishes a card a host restart left working from the guest's reply after the card started", async () => {
    const { nova, penny, posts, consults, reply, kinds } = harness();
    nova.status = "idle";
    const card: GuestEntry = { kind: "work", agent: { id: "penny", title: "Penny" }, work: { id: "w9", title: "Find an SSD", state: "working", startedAt: 500, link: "agent:penny" } };
    nova.rows = [{ id: "c1", role: "card", title: "Penny", text: "Working on Find an SSD in Penny's chat", at: 500, guest: card }];
    reply("Old answer from before the card", 400);
    reply("Acasis + SN7100, $189", 900);
    consults.observe({ kind: "sessions" });
    await settle();
    expect(kinds()).toEqual(["work:done"]);
    expect(posts[0]?.details).toMatchObject({ text: "Acasis + SN7100, $189", work: { id: "w9", state: "done", startedAt: 500 } });
    // Read once per session: a later change posts nothing again.
    consults.observe({ kind: "sessions" });
    await settle();
    expect(posts).toHaveLength(1);
  });
});

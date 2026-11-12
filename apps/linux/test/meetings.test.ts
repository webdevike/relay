import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LiveLine, ServerMessage } from "@relay/protocol";
import { parseProtocol } from "../../../packages/eva-core/src/model/protocol";
import type { Asr, Segment, Turn, WorkerLine } from "../src/meetings/asr";
import { ownSpeech, triples } from "../src/meetings/echo";
import { LiveTranscript } from "../src/meetings/live";
import {
  labelSegments,
  MeetingPipeline,
  micUtterances,
  namesFromCall,
  protocolStem,
  transcriptLines,
  type Autoname,
} from "../src/meetings/pipeline";
import { calendarTitle, routeMeeting } from "../src/meetings/route";
import { MeetingsService, qaOf, type AfterCall, type Conn } from "../src/meetings/service";
import { RecordingStore, type RecordingMeta } from "../src/meetings/store";
import type { IngestPeer } from "../src/seams";
import { FakeClock } from "./studio-fakes";

const dirs: string[] = [];
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ID = "6f1c2b8e-0d1a-4c55-9a51-3b2f0c7d9e10";
const AGENTS = [
  { id: "astra", profile: "work" as const },
  { id: "nova", profile: "personal" as const },
];
const wl = (
  track: "app" | "mic",
  start: number,
  text: string,
  final = true,
  id = `${track}-${String(start)}`,
): WorkerLine => ({
  ev: "line",
  meeting: ID,
  track,
  id,
  start: start * 16,
  end: (start + 2000) * 16,
  text,
  final,
});

function frame(track: number, at: number, samples: number): Uint8Array {
  const b = new Uint8Array(9 + samples * 2);
  const v = new DataView(b.buffer);
  v.setUint8(0, track);
  v.setBigInt64(1, BigInt(at), true);
  for (let i = 0; i < samples; i += 1) v.setInt16(9 + i * 2, (i % 100) - 50, true);
  return b;
}

describe("echo filter", () => {
  it("drops mic words the call just said and keeps own stretches of four or more", () => {
    const call = triples("the release goes out on tuesday after the standup");
    expect(ownSpeech("Yes.", call)).toBe("Yes.");
    expect(ownSpeech("The release goes out on Tuesday", call)).toBe("");
    expect(
      ownSpeech("The release goes out on Tuesday and I will check the build tonight", call),
    ).toBe("and I will check the build tonight");
    expect(ownSpeech("I will check the build tonight", call)).toBe(
      "I will check the build tonight",
    );
  });
});

describe("live transcript", () => {
  it("replaces drafts, keeps finals and marks mic echo of the call", () => {
    const t = new LiveTranscript([], { mic: "Isaac", remoteName: () => undefined });
    expect(t.apply(wl("mic", 0, "So the", false))[0]).toMatchObject({
      id: "mic-0",
      final: false,
      speaker: "Isaac",
    });
    t.apply(wl("mic", 0, "So the plan is fine"));
    expect(t.apply(wl("mic", 0, "late draft", false))).toEqual([]);
    // The call says it; Isaac's speakers play it into the mic a moment later.
    t.apply(wl("app", 3000, "We ship the new build on Friday morning"));
    t.apply(wl("mic", 3500, "We ship the new build on Friday morning"));
    const echo = t.all().find((l) => l.id === "mic-3500");
    expect(echo).toMatchObject({ echo: true, text: "We ship the new build on Friday morning" });
    // A mic line that arrived before the call line is checked again when it lands.
    t.apply(wl("mic", 9000, "Okay sounds good to me"));
    const changed = t.apply(wl("app", 8500, "okay sounds good to me"));
    expect(changed.map((l) => l.id)).toEqual(["app-8500", "mic-9000"]);
    expect(t.all().find((l) => l.id === "mic-9000")?.echo).toBe(true);
    expect(t.renameApp("Todd Barczak").every((l) => l.speaker === "Todd Barczak")).toBe(true);
  });
});

describe("call-track speakers", () => {
  const S = 16_000;
  /** Words of `text`, half a second each from `at` seconds. */
  const words = (at: number, text: string): [number, number, string][] =>
    text.split(" ").map((w, i) => [(at + i * 0.5) * S, (at + i * 0.5 + 0.45) * S, w]);
  const final = (at: number, text: string): WorkerLine => {
    const ws = words(at, text);
    return {
      ev: "line",
      meeting: ID,
      track: "app",
      id: `app-${String(at * S)}`,
      start: at * S,
      end: (ws.at(-1)?.[1] ?? at * S) + 0.1 * S,
      text,
      final: true,
      words: ws,
    };
  };
  const turns = (at: number, end: number, speaker: number, names: Record<string, string> = {}) => ({
    ev: "turns" as const,
    meeting: ID,
    id: `app-${String(at * S)}`,
    turns: [{ start: at * S, end: end * S, speaker }],
    names,
  });
  const roster = ["David Taylor", "Ted Plaisted"];

  it("splits a line where the window's talker changes, then names voices from what it learned", () => {
    const t = new LiveTranscript([], { mic: "Isaac", remoteName: () => undefined }, [
      { at: 0, speaking: ["David Taylor"], roster },
      { at: 5 * S, speaking: ["Ted Plaisted"], roster },
      { at: 10.2 * S, speaking: [], roster },
    ]);
    const out = t.apply(
      final(
        0,
        "we ship the build on friday after the team standup so what do you think about the release plan",
      ),
    );
    expect(out.map((l) => [l.id, l.speaker, l.text])).toEqual([
      ["app-0", "David Taylor", "we ship the build on friday after the team standup"],
      ["app-0.2", "Ted Plaisted", "so what do you think about the release plan"],
    ]);
    // The voices behind it: 2 is David, 3 is Ted (each over the vote minimum of marked speech).
    t.turns({
      ...turns(0, 5, 2),
      turns: [
        { start: 0, end: 5 * S, speaker: 2 },
        { start: 5 * S, end: 10 * S, speaker: 3 },
      ],
    });
    // Nobody marked on the window (silence, a hidden tile): the voice carries the name.
    t.apply(final(20, "I think we should wait for QA"));
    t.turns(turns(20, 24, 3));
    expect(t.all().find((l) => l.id === `app-${String(20 * S)}`)?.speaker).toBe("Ted Plaisted");
    // A voice the window never named keeps a stable label.
    t.apply(final(40, "hi everyone sorry I am late"));
    t.turns(turns(40, 44, 4));
    expect(t.all().find((l) => l.id === `app-${String(40 * S)}`)?.speaker).toBe("Speaker 4");
  });

  it("takes the voice's owner when two are marked, and the caption's name over the marks", () => {
    const t = new LiveTranscript([], { mic: "Isaac", remoteName: () => undefined }, [
      { at: 0, speaking: ["David Taylor"], roster },
      { at: 4 * S, speaking: [], roster },
    ]);
    t.apply(final(0, "let me share my screen for a second"));
    t.turns(turns(0, 4, 2));
    // Both marked (cross-talk; Ted listed first): the voice's owner, not the first mark.
    t.platform([{ at: 20 * S, speaking: ["Ted Plaisted", "David Taylor"], roster }]);
    t.apply(final(20, "no I meant the other report"));
    t.turns(turns(20, 23, 2));
    expect(t.all().find((l) => l.id === `app-${String(20 * S)}`)?.speaker).toBe("David Taylor");
    t.platform([
      { at: 30 * S, speaking: ["David Taylor"], roster },
      {
        at: 33 * S,
        speaking: [],
        roster,
        captions: [{ name: "Ted Plaisted", text: "The budget is final for Q3." }],
      },
    ]);
    expect(t.apply(final(30, "the budget is final for Q3"))[0]?.speaker).toBe("Ted Plaisted");
  });

  it("names after-call voices from the window, and a marked segment outright", () => {
    const samples = [
      { at: 0, speaking: ["David Taylor"], roster },
      { at: 5 * S, speaking: ["Ted Plaisted"], roster },
      { at: 9 * S, speaking: [], roster },
    ];
    const remote = labelSegments(
      [
        { start: 0, end: 4, text: "Here is the plan." },
        { start: 5, end: 8, text: "Sounds right." },
        { start: 12, end: 14, text: "One more thing." },
      ],
      [
        { start: 0, end: 4.5, speaker: 1 },
        { start: 4.5, end: 15, speaker: 1 },
      ],
    );
    const call = namesFromCall(
      remote,
      [
        { start: 0, end: 4.5, speaker: 1 },
        { start: 4.5, end: 15, speaker: 1 },
      ],
      samples,
      [],
    );
    // One over-merged voice: the segments the window marked go to their people.
    expect(call.remote.map((u) => u.label)).toEqual(["David Taylor", "Ted Plaisted", "R_S1"]);
    expect(call.roster).toEqual(roster);
  });
});

describe("pipeline pieces", () => {
  it("labels call segments by turn overlap, filters mic echo and formats the transcript", () => {
    const app: Segment[] = [
      { start: 0, end: 4, text: "Release is Tuesday after the standup." },
      { start: 5, end: 9, text: "Bill, can you take the fix?" },
    ];
    const turns: Turn[] = [
      { start: 0, end: 4.5, speaker: 1 },
      { start: 4.5, end: 10, speaker: 2 },
    ];
    expect(labelSegments(app, turns).map((u) => u.label)).toEqual(["R_S1", "R_S2"]);
    const mic = micUtterances(
      [
        { start: 1, end: 3, text: "Release is Tuesday after the standup." },
        { start: 10, end: 12, text: "Yeah I can look at it." },
      ],
      app,
    );
    expect(mic.map((u) => u.text)).toEqual(["Yeah I can look at it."]);
    expect(
      transcriptLines([...labelSegments(app, turns), ...mic], { M_S1: "Isaac", R_S1: "Todd" }),
    ).toBe(
      "[0:00] Todd: Release is Tuesday after the standup.\n[0:05] R_S2: Bill, can you take the fix?\n[0:10] Isaac: Yeah I can look at it.",
    );
    expect(
      protocolStem({
        id: ID,
        app: "Microsoft Teams",
        title: "Weekly Engineering Team Sync!",
        startedAt: new Date(2026, 10, 2, 10, 4).getTime(),
      }),
    ).toBe("20261102_1004_weekly_engineering_team_sync_6f1c2b8e");
  });

  it("writes notes in MeetingTranscriber's format", async () => {
    const root = tmp("relay-meet-");
    const store = new RecordingStore(join(root, "rec"));
    const meta = baseMeta({ total: { app: 16000, mic: 16000 }, names: { R_S2: "Bill" } });
    store.save(meta);
    store.writePcm(ID, "app", 0, new Uint8Array(32000));
    store.writePcm(ID, "mic", 0, new Uint8Array(32000));
    const calls: string[][] = [];
    const asr: Asr = {
      ...idleAsr(),
      aec: (_a, _m, out) => {
        writeFileSync(out, "");
        return Promise.resolve();
      },
      transcribe: (wav) =>
        Promise.resolve(
          wav.endsWith("app.wav")
            ? [
                { start: 0, end: 3, text: "Release is Tuesday." },
                { start: 4, end: 6, text: "I'll fix it." },
              ]
            : [{ start: 7, end: 8, text: "Great, thanks." }],
        ),
      diarize: () =>
        Promise.resolve([
          { start: 0, end: 3.5, speaker: 1 },
          { start: 3.5, end: 7, speaker: 2 },
        ]),
    };
    const autoname: Autoname = {
      lookupMeeting: () =>
        Promise.resolve({ annotation: '**Attendees:** Todd, Bill, Isaac (Outlook: "Sync")' }),
      autoMapping: (speakers, mic) =>
        Object.fromEntries(
          speakers.map((s) => [s.label, s.label.startsWith("M_") ? mic : s.label]),
        ),
      withAttendees: (md, m) => md.replace(/(\*\*Time:\*\*.*\n)/, `$1${m.annotation}\n`),
    };
    const stages: string[] = [];
    const pipeline = new MeetingPipeline({
      store,
      asr,
      agentHome: null,
      protocolsDir: join(root, "shadow"),
      human: "Isaac",
      claude: "claude",
      run: (argv) => {
        calls.push([...argv]);
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            result:
              "Sure.\n## Summary\nRelease on Tuesday.\n## Participants\n- Isaac\n## Topics Discussed\n### Release\n- Tuesday\n## Decisions\n- Ship Tuesday.\n## Tasks\n| Task | Responsible | Deadline | Priority |\n|------|-------------|----------|----------|\n| Fix it | Bill | Open | 🟡 medium |\n## Open Questions\n- None.",
          }),
          stderr: "",
          timedOut: false,
        });
      },
      autoname: () => Promise.resolve(autoname),
      log: () => undefined,
    });
    const out = await pipeline.run(
      meta,
      [],
      [{ question: "When is the release?", answer: "Tuesday." }],
      { stage: (s) => stages.push(s) },
    );
    expect(stages).toEqual(["transcribing", "diarizing", "naming", "summarizing"]);
    const stem = out?.stem ?? "";
    expect(stem).toBe(protocolStem(meta));
    const md = readFileSync(join(root, "shadow", `${stem}.md`), "utf8");
    expect(
      md.startsWith(
        "# Meeting Protocol - Weekly Sync\n**Date:** 2026-11-02\n**Time:** 10:04\n**Attendees:** Todd, Bill, Isaac",
      ),
    ).toBe(true);
    expect(md).toContain("## Questions asked during the call");
    const parsed = parseProtocol(md);
    expect(parsed.summary).toEqual(["Release on Tuesday."]);
    expect(parsed.decisions).toEqual(["Ship Tuesday."]);
    expect(parsed.transcript.map((l) => `${l.speaker ?? ""}: ${l.text}`)).toEqual([
      "R_S1: Release is Tuesday.",
      "Bill: I'll fix it.",
      "Isaac: Great, thanks.",
    ]);
    expect(calls[0]).toContain("--tools");
    expect(pipeline.notes({ ...meta, stem })).toBe(md);
    await pipeline.rename({ ...meta, stem }, "R_S1", "Todd Barczak");
    expect(readFileSync(join(root, "shadow", `${stem}.txt`), "utf8")).toContain(
      "[0:00] Todd Barczak: Release is Tuesday.",
    );
  });

  it("collects Astra's questions and answers", () => {
    expect(
      qaOf({
        url: "u",
        title: "t",
        sessionId: null,
        working: false,
        waiting: null,
        error: null,
        turns: [
          { id: "1", role: "user", text: "Who owns the fix?", streaming: false },
          { id: "2", role: "tool", text: "read", streaming: false },
          { id: "3", role: "assistant", text: "Bill.", streaming: false },
          { id: "4", role: "user", text: "Unanswered?", streaming: false },
        ],
      }),
    ).toEqual([{ question: "Who owns the fix?", answer: "Bill." }]);
  });
});

function baseMeta(extra: Partial<RecordingMeta> = {}): RecordingMeta {
  return {
    id: ID,
    app: "Microsoft Teams",
    title: "Weekly Sync",
    startedAt: new Date(2026, 10, 2, 10, 4).getTime(),
    endedAt: null,
    device: "Mini",
    deviceId: "dev1",
    stage: "recording",
    health: "ok",
    healthDetail: "",
    error: null,
    shadow: true,
    stem: null,
    total: null,
    micLeadMs: null,
    globalTap: false,
    context: null,
    names: {},
    assistant: null,
    ...extra,
  };
}

function idleAsr(): Asr & {
  opened: unknown[];
  audioCalls: [string, number, number][];
  closed: string[];
} {
  const opened: unknown[] = [];
  const audioCalls: [string, number, number][] = [];
  const closed: string[] = [];
  return {
    opened,
    audioCalls,
    closed,
    open: (meeting, app, mic) => opened.push([meeting, app, mic]),
    learn: () => undefined,
    audio: (_m, track, at, pcm) => audioCalls.push([track, at, pcm.byteLength / 2]),
    close: (m) => {
      closed.push(m);
      return Promise.resolve();
    },
    aec: () => Promise.resolve(),
    transcribe: () => Promise.resolve([]),
    diarize: () => Promise.resolve([]),
    stop: () => undefined,
  };
}

describe("meetings service", () => {
  it("takes a recording from ticket to notes", async () => {
    const root = tmp("relay-meet-svc-");
    const store = new RecordingStore(join(root, "rec"));
    const asr = idleAsr();
    const clock = new FakeClock();
    const sent: ServerMessage[] = [];
    const pushes: string[] = [];
    const ran: { lines: readonly LiveLine[] } = { lines: [] };
    const afterCall: AfterCall = {
      run: (meta, lines, _qa, report) => {
        ran.lines = lines;
        report.stage("summarizing");
        return Promise.resolve({ stem: "20261102_1004_weekly_sync_6f1c2b8e" });
      },
      notes: () => "# Meeting Protocol - Weekly Sync\n\n## Summary\nDone.\n",
      rename: () => Promise.resolve(),
      remove: () => undefined,
      lookup: () =>
        Promise.resolve({ annotation: "**Attendees:** Todd, Isaac", remoteName: "Todd" }),
    };
    const service = new MeetingsService({
      store,
      asr,
      agentHome: null,
      shadow: true,
      human: "Isaac",
      afterCall,
      agents: {
        sessions: [],
        conversation: () => Promise.resolve(null),
        reply: () => Promise.resolve(),
        configure: () => Promise.resolve(),
      },
      launch: null,
      sessionFile: () => null,
      socketPath: "/tmp/none.sock",
      broadcast: (m) => sent.push(m),
      push: (title) => pushes.push(title),
      clock,
      log: () => undefined,
      assistants: () => AGENTS,
    });

    const r = service.openIngest("dev1", "Isaac's Mac mini", {
      id: ID,
      app: "Microsoft Teams",
      title: "Weekly Sync",
      startedAt: clock.now(),
    });
    expect("ticket" in r).toBe(true);
    if (!("ticket" in r)) return;
    expect(service.openIngest("dev2", "MacBook", { id: ID, app: "Zoom", startedAt: 1 })).toEqual({
      refused: "another Mac holds this recording",
    });
    expect(pushes).toEqual(["Recording Weekly Sync"]);
    // A Teams call is eCard work: Astra's chat.
    expect(store.load(ID)?.assistant).toBe("astra");
    const grant = service.redeem(r.ticket);
    if (grant === null) throw new Error("ticket not redeemed");
    expect(grant).toMatchObject({ id: ID, deviceId: "dev1" });
    expect(service.redeem(r.ticket)).toBeNull();

    const out: Record<string, unknown>[] = [];
    const peer: IngestPeer = { sendText: (f) => out.push(f), close: () => undefined };
    const conn = service.connect(grant, peer);
    conn.text(
      JSON.stringify({
        t: "meeting.hello",
        id: ID,
        app: "Microsoft Teams",
        startedAt: clock.now(),
      }),
    );
    expect(out).toEqual([
      { t: "ack", track: 0, upTo: 0 },
      { t: "ack", track: 1, upTo: 0 },
      { t: "ack.speakers", upTo: 0 },
    ]);
    expect(asr.opened).toEqual([[ID, 0, 0]]);
    // The window's speaker samples: kept in order, a resend skipped, a bad one still counted (the
    // acks are the Mac's line numbers).
    const sample = (at: number): Record<string, unknown> => ({
      at,
      speaking: [],
      roster: ["Todd", "Bill"],
    });
    conn.text(
      JSON.stringify({ t: "meeting.speakers", from: 0, lines: [sample(9_600_000), { at: -1 }] }),
    );
    conn.text(
      JSON.stringify({ t: "meeting.speakers", from: 1, lines: [{ at: -1 }, sample(9_700_000)] }),
    );
    conn.text(JSON.stringify({ t: "meeting.speakers", from: 5, lines: [sample(9_800_000)] }));
    expect(store.speakers(ID)).toMatchObject({
      rows: 3,
      samples: [{ at: 9_600_000 }, { at: 9_700_000 }],
    });
    (conn as Conn).sendAcks();
    expect(out.at(-1)).toEqual({ t: "ack.speakers", upTo: 3 });

    conn.binary(frame(0, 0, 1600));
    conn.binary(frame(1, 0, 1600));
    // A resend of what the host has is dropped; a frame overlapping it adds only the new part.
    conn.binary(frame(0, 0, 1600));
    conn.binary(frame(0, 800, 1600));
    expect(asr.audioCalls).toEqual([
      ["app", 0, 1600],
      ["mic", 0, 1600],
      ["app", 1600, 800],
    ]);
    expect(readFileSync(join(store.dir(ID), "app.pcm")).length).toBe(2400 * 2);

    service.line(wl("app", 0, "Release is Tuesday."));
    service.line(wl("mic", 3000, "Great", false));
    clock.advance(300);
    const live = sent.filter((m) => m.t === "meeting.live");
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      t: "meeting.live",
      id: ID,
      upsert: [
        { id: "app-0", speaker: "Remote" },
        { id: "mic-3000", speaker: "Isaac", final: false },
      ],
    });
    // A minute in, the calendar names the 1:1's other side on every call line.
    clock.advance(60_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.filter((m) => m.t === "meeting.live").at(-1)).toMatchObject({
      upsert: [{ id: "app-0", speaker: "Todd" }],
    });

    const opened = await service.handle({ kind: "open", id: ID });
    expect(opened.snapshot?.lines.map((l) => l.id)).toEqual(["app-0", "mic-3000"]);
    expect(opened.snapshot?.recording).toMatchObject({ stage: "recording", seconds: 0.2 });

    // The Mac says it is done at 2400 / 2000 samples; the host still lacks 400 mic samples.
    conn.text(JSON.stringify({ t: "meeting.end", samples: [2400, 2000], endedAt: clock.now() }));
    expect(store.load(ID)?.stage).toBe("uploading");
    expect(out.some((f) => f["t"] === "meeting.done")).toBe(false);
    conn.binary(frame(1, 1600, 400));
    expect(out.some((f) => f["t"] === "meeting.done")).toBe(true);
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(asr.closed).toEqual([ID]);
    expect(ran.lines.map((l) => l.id)).toEqual(["app-0", "mic-3000"]);
    const done = store.load(ID);
    expect(done).toMatchObject({
      stage: "done",
      stem: "20261102_1004_weekly_sync_6f1c2b8e",
      total: { app: 2400, mic: 2000 },
    });
    expect(pushes).toEqual(["Recording Weekly Sync", "Notes ready"]);
    expect((await service.handle({ kind: "open", id: ID })).snapshot?.notes?.summary).toEqual([
      "Done.",
    ]);
    expect(service.state().recordings.map((x) => x.id)).toEqual([ID]);
    // The live session ended with the call: only finals were kept.
    expect(store.lines(ID).map((l) => l.id)).toEqual(["app-0"]);

    expect(await service.handle({ kind: "stop", id: ID })).toMatchObject({ ok: false });
    expect(await service.handle({ kind: "discard", id: ID })).toEqual({ ok: true });
    expect(store.load(ID)).toBeNull();
    conn.closed();
    service.stop();
  });

  it("asks Astra with the transcript so far, and the lines since on a follow-up", async () => {
    const root = tmp("relay-meet-astra-");
    const home = join(root, "home");
    mkdirSync(join(home, ".omp", "assistant", "agents", "astra"), { recursive: true });
    writeFileSync(
      join(home, ".omp", "assistant", "agents.json"),
      JSON.stringify({ agents: [{ id: "astra", title: "Astra", profile: "work" }] }),
    );
    writeFileSync(join(home, ".omp", "assistant", "agents", "astra", "prime.md"), "You are Astra.");
    const store = new RecordingStore(join(root, "rec"));
    store.save(baseMeta());
    const clock = new FakeClock();
    const prompts: string[] = [];
    const replies: string[] = [];
    const sessions: { id: string; status: string }[] = [];
    const service = new MeetingsService({
      store,
      asr: idleAsr(),
      agentHome: home,
      shadow: true,
      human: "Isaac",
      afterCall: {
        run: () => Promise.resolve(null),
        notes: () => null,
        rename: () => Promise.resolve(),
        remove: () => undefined,
        lookup: () => Promise.resolve(null),
      },
      agents: {
        get sessions() {
          return sessions as never;
        },
        conversation: () => Promise.resolve([]),
        reply: (_id, text) => {
          replies.push(text);
          return Promise.resolve();
        },
        configure: () => Promise.resolve(),
      },
      launch: (options) => {
        prompts.push(options.prompt ?? "");
        return Promise.resolve({ joined: Promise.resolve("s1") });
      },
      sessionFile: () => null,
      socketPath: "/tmp/none.sock",
      broadcast: () => undefined,
      push: () => undefined,
      clock,
      log: () => undefined,
      assistants: () => AGENTS,
    });
    const conn = service.connect(
      { id: ID, deviceId: "dev1", deviceName: "Mini" },
      { sendText: () => undefined, close: () => undefined },
    );
    conn.text(JSON.stringify({ t: "meeting.hello", id: ID }));
    service.line(wl("app", 0, "Release is Tuesday."));
    const first = await service.handle({ kind: "ask", id: ID, question: "When is the release?" });
    expect(first.ok).toBe(true);
    expect(prompts[0]).toContain("You are Astra.");
    expect(prompts[0]).toContain("[0:00] Remote: Release is Tuesday.");
    expect(prompts[0]?.endsWith("When is the release?")).toBe(true);
    expect(first.astra?.turns).toEqual([
      expect.objectContaining({ role: "user", text: "When is the release?" }),
    ]);
    sessions.push({ id: "s1", status: "idle" });
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    service.line(wl("app", 5000, "Bill takes the fix."));
    await service.handle({ kind: "ask", id: ID, question: "Who takes the fix?" });
    expect(replies[0]).toContain(
      "New in the transcript since your last answer:\n[0:05] Remote: Bill takes the fix.",
    );
    expect(replies[0]?.endsWith("Who takes the fix?")).toBe(true);
    expect(replies[0]).not.toContain("Release is Tuesday");
    conn.closed();
    service.stop();
  });
});

describe("meetings in an assistant's chat", () => {
  it("routes eCard work to the work assistant and the rest to the personal one", () => {
    const meta = (app: string, annotation: string | null, title: string | null = null) => ({
      app,
      title,
      context: annotation === null ? null : { annotation },
    });
    expect(routeMeeting(meta("Microsoft Teams", null), AGENTS)).toBe("astra");
    expect(routeMeeting(meta("Zoom", null), AGENTS)).toBe("nova");
    expect(routeMeeting(meta("Slack", '**Attendees:** Bill (Outlook: "Design Review")'), AGENTS)).toBe("astra");
    expect(routeMeeting(meta("Slack", null, "eCard platform huddle"), AGENTS)).toBe("astra");
    expect(routeMeeting(meta("Zoom", "**Attendees:** Mom, Dad"), AGENTS)).toBe("nova");
    // A registry with only one kind still gets the meeting; none at all routes nowhere.
    expect(routeMeeting(meta("Zoom", null), [{ id: "astra", profile: "work" }])).toBe("astra");
    expect(routeMeeting(meta("Zoom", null), [])).toBeNull();
    expect(calendarTitle('**Attendees:** A, B (Outlook: "Release Planning (updated)")')).toBe(
      "Release Planning (updated)",
    );
    expect(calendarTitle("**Attendees:** A, B")).toBeNull();
  });

  function service(lookup: AfterCall["lookup"]) {
    const store = new RecordingStore(join(tmp("relay-meet-route-"), "rec"));
    const clock = new FakeClock();
    const sent: ServerMessage[] = [];
    const svc = new MeetingsService({
      store,
      asr: idleAsr(),
      agentHome: null,
      shadow: true,
      human: "Isaac",
      afterCall: {
        run: () => Promise.resolve(null),
        notes: () => null,
        rename: () => Promise.resolve(),
        remove: () => undefined,
        lookup,
      },
      agents: {
        sessions: [],
        conversation: () => Promise.resolve(null),
        reply: () => Promise.resolve(),
        configure: () => Promise.resolve(),
      },
      launch: null,
      sessionFile: () => null,
      socketPath: "/tmp/none.sock",
      broadcast: (m) => sent.push(m),
      push: () => undefined,
      clock,
      log: () => undefined,
      assistants: () => AGENTS,
    });
    return { store, clock, sent, svc };
  }
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  };

  it("lets the calendar name and reroute a call", async () => {
    const outlook = { annotation: '**Attendees:** Todd, Isaac (Outlook: "Release Planning")' };
    const a = service(() => Promise.resolve(outlook));
    a.svc.openIngest("dev1", "Mini", { id: ID, app: "Zoom", startedAt: a.clock.now() });
    expect(a.store.load(ID)).toMatchObject({ assistant: "nova", title: null });
    a.clock.advance(60_000);
    await settle();
    expect(a.store.load(ID)).toMatchObject({ assistant: "astra", title: "Release Planning" });
    expect(a.sent.filter((m) => m.t === "meeting.recording").at(-1)).toMatchObject({
      recording: { assistant: "astra", title: "Release Planning" },
    });
  });

  it("hands the chat's assistant the transcript so far, then only what is new, then the end once", () => {
    const { store, clock, svc } = service(() => Promise.resolve(null));
    svc.openIngest("dev1", "Mini", {
      id: ID,
      app: "Microsoft Teams",
      title: "Dev Sync",
      startedAt: clock.now(),
    });
    const conn = svc.connect(
      { id: ID, deviceId: "dev1", deviceName: "Mini" },
      { sendText: () => undefined, close: () => undefined },
    );
    conn.text(JSON.stringify({ t: "meeting.hello", id: ID }));
    expect(svc.contextFor("astra")?.text).toContain("(nothing new said)");
    svc.line(wl("app", 0, "Release is Tuesday."));
    svc.line(wl("mic", 3000, "I can take the dashboard", false));
    // Not the chat it is in.
    expect(svc.contextFor("nova")).toBeNull();
    const first = svc.contextFor("astra");
    expect(first?.id).toBe(ID);
    expect(first?.text).toContain('Isaac is in a meeting right now and it is in your chat: "Dev Sync"');
    expect(first?.text).toContain("New in the transcript since your last turn:");
    expect(first?.text).toContain("[0:00] Remote: Release is Tuesday.");
    expect(first?.text).toContain("[0:03] Isaac: I can take the dashboard (still speaking)");
    // Only a draft since: nothing to add.
    expect(svc.contextFor("astra")).toBeNull();
    svc.line(wl("mic", 3000, "I can take the dashboard."));
    svc.line(wl("app", 9000, "Great, thanks."));
    const next = svc.contextFor("astra")?.text ?? "";
    expect(next).toContain("[0:03] Isaac: I can take the dashboard.");
    expect(next).toContain("[0:09] Remote: Great, thanks.");
    expect(next).not.toContain("Release is Tuesday");

    const m = store.load(ID);
    if (m === null) throw new Error("no recording");
    store.save({ ...m, stage: "done", endedAt: clock.now() });
    expect(svc.contextFor("astra")?.text).toContain('The meeting "Dev Sync" (Microsoft Teams');
    expect(svc.contextFor("astra")).toBeNull();
    clock.advance(31 * 60_000);
    expect(svc.contextFor("astra")).toBeNull();
    conn.closed();
    svc.stop();
  });
});

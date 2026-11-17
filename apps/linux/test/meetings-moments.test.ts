// Key moments and screen snapshots on the host: found and kept while the call is on, snapshots
// ingested from the Mac and served by token, the share state, and both in the after-call notes.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { KeyMoment, LiveLine, ServerMessage } from "@relay/protocol";
import { parseProtocol } from "../../../packages/eva-core/src/model/protocol";
import type { Asr, WorkerLine } from "../src/meetings/asr";
import { handleMeetingShot } from "../src/meetings/http";
import { claudeFinder, replayKeyMoments, type MomentFinder } from "../src/meetings/key-moments";
import { KEY_MOMENTS_WINDOW_MS, type ExtractInput } from "../src/meetings/key-moments.machine";
import { keyMomentsSection, MeetingPipeline, snapshotsSection } from "../src/meetings/pipeline";
import { lineAt, MeetingsService, type AfterCall, type Conn } from "../src/meetings/service";
import { RecordingStore, type RecordingMeta, type ShotRow } from "../src/meetings/store";
import type { IngestGrant } from "../src/seams";
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
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

const wl = (track: "app" | "mic", start: number, text: string): WorkerLine => ({
  ev: "line",
  meeting: ID,
  track,
  id: `${track}-${String(start)}`,
  start: start * 16,
  end: (start + 2000) * 16,
  text,
  final: true,
});

/** Every pending promise callback runs (nothing here waits on real timers). */
async function settle(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  await promise;
}

function asr(): Asr {
  return {
    open: () => undefined,
    learn: () => undefined,
    audio: () => undefined,
    close: () => Promise.resolve(),
    aec: (_a, _m, out) => {
      writeFileSync(out, "");
      return Promise.resolve();
    },
    transcribe: () => Promise.resolve([]),
    diarize: () => Promise.resolve([]),
    stop: () => undefined,
  };
}

function afterCallStub(extra: Partial<AfterCall> = {}): AfterCall {
  return {
    run: () => Promise.resolve(null),
    notes: () => null,
    rename: () => Promise.resolve(),
    remove: () => undefined,
    shotPath: () => null,
    lookup: () => Promise.resolve(null),
    ...extra,
  };
}

function makeService(o: {
  store: RecordingStore;
  clock: FakeClock;
  sent: ServerMessage[];
  afterCall?: AfterCall;
  findMoments?: MomentFinder | null;
}): MeetingsService {
  return new MeetingsService({
    store: o.store,
    asr: asr(),
    agentHome: null,
    shadow: true,
    human: "Isaac",
    afterCall: o.afterCall ?? afterCallStub(),
    agents: {
      sessions: [],
      conversation: () => Promise.resolve(null),
      reply: () => Promise.resolve(),
      configure: () => Promise.resolve(),
    },
    launch: null,
    sessionFile: () => null,
    socketPath: "/tmp/none.sock",
    broadcast: (m) => o.sent.push(m),
    push: () => undefined,
    clock: o.clock,
    log: () => undefined,
    assistants: () => [],
    findMoments: o.findMoments ?? null,
  });
}

/** A recording opened by `dev1` with its ingest socket said hello on. */
function connect(
  svc: MeetingsService,
  clock: FakeClock,
): { conn: Conn; out: Record<string, unknown>[] } {
  const r = svc.openIngest("dev1", "MacBook", {
    id: ID,
    app: "Microsoft Teams",
    title: "Weekly Sync",
    startedAt: clock.now(),
  });
  if (!("ticket" in r)) throw new Error("refused");
  const grant = svc.redeem(r.ticket) as IngestGrant;
  const out: Record<string, unknown>[] = [];
  const conn = svc.connect(grant, { sendText: (f) => out.push(f), close: () => undefined }) as Conn;
  conn.text(JSON.stringify({ t: "meeting.hello", id: ID }));
  return { conn, out };
}

/** Moments for every line that says "decide". */
function decider(calls: ExtractInput[]): MomentFinder {
  return (input) => {
    calls.push(input);
    return Promise.resolve(
      input.lines
        .filter((l) => /decide/i.test(l.text))
        .map((l) => ({ lineId: l.id, kind: "decision" as const, text: l.text })),
    );
  };
}

describe("key moments on the host", () => {
  it("finds them while the call is on, keeps them over a restart and waits for the last ones", async () => {
    const store = new RecordingStore(join(tmp("relay-km-"), "rec"));
    const clock = new FakeClock();
    const sent: ServerMessage[] = [];
    const calls: ExtractInput[] = [];
    const svc = makeService({ store, clock, sent, findMoments: decider(calls) });
    connect(svc, clock);
    svc.line(wl("app", 0, "We decide to ship Tuesday."));
    clock.advance(KEY_MOMENTS_WINDOW_MS - 1);
    expect(calls).toHaveLength(0);
    clock.advance(1);
    await settle();
    expect(calls[0]?.lines.map((l) => l.id)).toEqual(["app-0"]);
    const first = {
      id: "km0",
      kind: "decision",
      atMs: 0,
      lineId: "app-0",
      speaker: "Remote",
      text: "We decide to ship Tuesday.",
      shot: null,
    };
    expect(sent.filter((m) => m.t === "meeting.moments")).toEqual([
      { t: "meeting.moments", id: ID, moments: [first] },
    ]);
    expect(store.moments(ID)).toEqual({ moments: [first], through: 0 });
    expect((await svc.handle({ kind: "open", id: ID })).snapshot?.moments).toEqual([first]);
    svc.stop();

    // A restart mid-call: what was found stays, what was looked at is not looked at again.
    const runs: KeyMoment[][] = [];
    const svc2 = makeService({
      store,
      clock,
      sent,
      findMoments: decider(calls),
      afterCall: afterCallStub({
        run: () => {
          runs.push(store.moments(ID).moments);
          return Promise.resolve(null);
        },
      }),
    });
    const { conn } = connect(svc2, clock);
    clock.advance(KEY_MOMENTS_WINDOW_MS);
    await settle();
    expect(calls).toHaveLength(1);
    svc2.line(wl("app", 60_000, "Then we decide on Postgres."));
    svc2.line(wl("mic", 63_000, "Sounds good."));
    // The call ends before the window closes: the last pass runs before the notes.
    conn.text(JSON.stringify({ t: "meeting.end", samples: [0, 0], endedAt: clock.now() }));
    await settle();
    expect(calls[1]?.lines.map((l) => l.id)).toEqual(["app-60000", "mic-63000"]);
    expect(calls[1]?.context.map((l) => l.id)).toEqual([]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.map((m) => [m.id, m.text])).toEqual([
      ["km0", "We decide to ship Tuesday."],
      ["km1", "Then we decide on Postgres."],
    ]);
    svc2.stop();
  });
});

describe("screen snapshots on the host", () => {
  const shotFrame = (n: number, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      t: "meeting.shot",
      shot: {
        n,
        at: 5_000 * 16,
        t: 1_763_400_000_000,
        w: 1920,
        h: 1080,
        hash: "ab".repeat(32),
        ocr: "Q3 plan",
        ...extra,
      },
      jpeg: JPEG.toString("base64"),
    });

  it("keeps them in order, acks them, skips resends and serves them by token", async () => {
    const root = tmp("relay-shots-");
    const store = new RecordingStore(join(root, "rec"));
    const clock = new FakeClock();
    const sent: ServerMessage[] = [];
    const svc = makeService({
      store,
      clock,
      sent,
      afterCall: afterCallStub({
        shotPath: (meta, n) =>
          meta.stem === null ? null : join(root, "notes", `${String(n)}.jpg`),
      }),
    });
    const { conn, out } = connect(svc, clock);
    expect(out).toContainEqual({ t: "ack.shots", upTo: 0 });
    svc.line(wl("app", 4_000, "So this is the pass."));
    conn.text(shotFrame(0));
    conn.text(shotFrame(0, { ocr: "resent" }));
    conn.text(shotFrame(2));
    conn.text(shotFrame(1, { w: 0 }));
    conn.text(shotFrame(2, { ocr: "x".repeat(5_000) }));
    conn.sendAcks();
    expect(out.at(-1)).toEqual({ t: "ack.shots", upTo: 3 });
    const { rows, count } = store.shots(ID);
    expect(count).toBe(3);
    expect(rows.map((r) => [r.n, r.atMs, r.line, r.ocr.length])).toEqual([
      [0, 5_000, "Remote: So this is the pass.", 7],
      [2, 5_000, "Remote: So this is the pass.", 4_000],
    ]);
    expect(readFileSync(store.shotFile(ID, 0))).toEqual(JPEG);
    const token = store.load(ID)?.shotToken ?? "";
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    const shots = sent.flatMap((m) => (m.t === "meeting.shot" ? [m.shot] : []));
    expect(shots.map((s) => s.src)).toEqual([
      `/meetings/shots/${ID}/${token}/0`,
      `/meetings/shots/${ID}/${token}/2`,
    ]);
    expect((await svc.handle({ kind: "open", id: ID })).snapshot?.shots).toEqual(shots);

    // Served by token from the recording, then from next to the notes once they exist.
    const get = (path: string, method = "GET"): Response =>
      handleMeetingShot(svc, new Request(`http://host${path}`, { method }), path);
    const ok = get(`/meetings/shots/${ID}/${token}/0`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(JPEG);
    expect(get(`/meetings/shots/${ID}/${token}/0`, "HEAD").status).toBe(200);
    expect(get(`/meetings/shots/${ID}/${"0".repeat(32)}/0`).status).toBe(404);
    expect(get(`/meetings/shots/${ID}/${token}/1`).status).toBe(404);
    expect(get(`/meetings/shots/..%2F/${token}/0`).status).toBe(404);
    expect(get(`/meetings/shots/${ID}/${token}/0`, "POST").status).toBe(405);
    const meta = store.load(ID) as RecordingMeta;
    store.save({ ...meta, stem: "20261102_1004_weekly_sync_6f1c2b8e" });
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "notes", "0.jpg"), Buffer.from([0xff, 0xd8, 9]));
    expect(Buffer.from(await get(`/meetings/shots/${ID}/${token}/0`).arrayBuffer())).toEqual(
      Buffer.from([0xff, 0xd8, 9]),
    );
    svc.stop();
  });

  it("takes the share state only from the Mac holding the call, until the call ends", () => {
    const store = new RecordingStore(join(tmp("relay-share-"), "rec"));
    const clock = new FakeClock();
    const sent: ServerMessage[] = [];
    const svc = makeService({ store, clock, sent });
    const { conn } = connect(svc, clock);
    const shares = (): string[] =>
      sent.flatMap((m) => (m.t === "meeting.recording" ? [m.recording.share] : []));
    expect(shares().at(-1)).toBe("none");
    svc.share("dev2", ID, "sharing");
    expect(store.load(ID)?.share).toBe("none");
    svc.share("dev1", ID, "sharing");
    svc.share("dev1", ID, "no-permission");
    expect(shares().slice(-2)).toEqual(["sharing", "no-permission"]);
    conn.text(JSON.stringify({ t: "meeting.end", samples: [1, 1], endedAt: clock.now() }));
    expect(store.load(ID)).toMatchObject({ stage: "uploading", share: "none" });
    svc.share("dev1", ID, "sharing");
    expect(store.load(ID)?.share).toBe("none");
    svc.stop();
  });

  it("names the line said at a snapshot's moment", () => {
    const l = (startMs: number, endMs: number, text: string, echo?: boolean): LiveLine => ({
      id: String(startMs),
      track: "app",
      speaker: "Todd",
      startMs,
      endMs,
      text,
      final: true,
      ...(echo === undefined ? {} : { echo }),
    });
    const lines = [
      l(0, 2_000, "First."),
      l(3_000, 9_000, "Second."),
      l(4_000, 5_000, "echo", true),
    ];
    expect(lineAt(lines, 4_500)).toBe("Todd: Second.");
    expect(lineAt(lines, 20_000)).toBe("Todd: Second.");
    expect(lineAt(lines, 30_000)).toBe("");
    expect(lineAt([l(0, 1, "x".repeat(400))], 1)).toHaveLength(300);
  });
});

describe("key moments and snapshots in the notes", () => {
  const moment = (over: Partial<KeyMoment>): KeyMoment => ({
    id: "km0",
    kind: "decision",
    atMs: 5_000,
    lineId: "app-5000",
    speaker: "Todd",
    text: "Ship Tuesday",
    shot: null,
    ...over,
  });
  const row = (n: number, over: Partial<ShotRow> = {}): ShotRow => ({
    n,
    atMs: 4_000,
    w: 1920,
    h: 1080,
    hash: "",
    ocr: "",
    line: "",
    ...over,
  });

  it("writes the sections as plain lines", () => {
    expect(
      keyMomentsSection(
        [
          moment({ shot: 0 }),
          moment({ id: "km1", kind: "ask", atMs: 65_000, shot: 7, text: "Send the deck" }),
        ],
        "stem",
        [row(0)],
      ),
    ).toBe(
      "## Key Moments\n\n- [0:05] Decision (Todd): Ship Tuesday ([snapshot](stem.shots/000.jpg))\n- [1:05] Ask (Todd): Send the deck\n",
    );
    expect(keyMomentsSection([], "stem", [])).toBe("");
    expect(
      snapshotsSection(
        [
          row(0, { line: "Todd: so this\n is the pass", ocr: `Q3\n\nplan ${"y".repeat(300)}` }),
          row(1),
        ],
        "stem",
      ),
    ).toBe(
      `## Screen Snapshots\n\n- [0:04] ![Snapshot at 0:04](stem.shots/000.jpg)\n  Said: Todd: so this is the pass\n  On screen: Q3 plan ${"y".repeat(192)}...\n- [0:04] ![Snapshot at 0:04](stem.shots/001.jpg)\n`,
    );
  });

  it("copies the snapshots next to the notes, lists both and deletes them with the notes", async () => {
    const root = tmp("relay-km-notes-");
    const store = new RecordingStore(join(root, "rec"));
    const meta: RecordingMeta = {
      id: ID,
      app: "Microsoft Teams",
      title: "Weekly Sync",
      startedAt: new Date(2026, 10, 2, 10, 4).getTime(),
      endedAt: null,
      device: "Mini",
      deviceId: "dev1",
      stage: "transcribing",
      health: "ok",
      healthDetail: "",
      error: null,
      shadow: true,
      stem: null,
      total: { app: 16000, mic: 16000 },
      micLeadMs: null,
      globalTap: false,
      context: null,
      names: {},
      assistant: null,
      share: "none",
      shotToken: "t",
    };
    store.save(meta);
    store.appendShot(ID, { row: row(0, { line: "Todd: the plan", ocr: "Q3 plan" }), jpeg: JPEG });
    store.appendShot(ID, null);
    store.saveMoments(ID, {
      moments: [
        moment({ shot: 0 }),
        moment({ id: "km1", kind: "action", text: "Bill fixes the build" }),
      ],
      through: 5_000,
    });
    const pipeline = new MeetingPipeline({
      store,
      asr: {
        ...asr(),
        transcribe: (wav) =>
          Promise.resolve(
            wav.endsWith("app.wav") ? [{ start: 0, end: 3, text: "Release is Tuesday." }] : [],
          ),
        diarize: () => Promise.resolve([{ start: 0, end: 3.5, speaker: 1 }]),
      },
      agentHome: null,
      meetingsDir: root,
      human: "Isaac",
      claude: "claude",
      run: () =>
        Promise.resolve({
          code: 0,
          stdout: JSON.stringify({
            result:
              "## Summary\nRelease on Tuesday.\n## Decisions\n- Ship Tuesday.\n## Open Questions\n- None.",
          }),
          stderr: "",
          timedOut: false,
        }),
      autoname: () => Promise.resolve(null),
      log: () => undefined,
    });
    const out = await pipeline.run(meta, [], [{ question: "When?", answer: "Tuesday." }], {
      stage: () => undefined,
    });
    const stem = out?.stem ?? "";
    const md = readFileSync(join(root, "shadow", `${stem}.md`), "utf8");
    expect(md).toContain(
      `\n## Key Moments\n\n- [0:05] Decision (Todd): Ship Tuesday ([snapshot](${stem}.shots/000.jpg))\n- [0:05] Action (Todd): Bill fixes the build\n`,
    );
    expect(md).toContain(
      `\n## Screen Snapshots\n\n- [0:04] ![Snapshot at 0:04](${stem}.shots/000.jpg)\n  Said: Todd: the plan\n  On screen: Q3 plan\n`,
    );
    const at = (s: string): number => md.indexOf(s);
    expect(at("## Open Questions")).toBeLessThan(at("## Key Moments"));
    expect(at("## Key Moments")).toBeLessThan(at("## Screen Snapshots"));
    expect(at("## Screen Snapshots")).toBeLessThan(at("## Questions asked during the call"));
    expect(at("## Questions asked during the call")).toBeLessThan(at("## Full Transcript"));
    // The protocol readers skip the new sections: nothing leaks into decisions or questions.
    const parsed = parseProtocol(md);
    expect(parsed.summary).toEqual(["Release on Tuesday."]);
    expect(parsed.decisions).toEqual(["Ship Tuesday."]);
    expect(parsed.questions).toEqual(["None."]);
    expect(parsed.transcript.map((l) => l.text)).toEqual(["Release is Tuesday."]);
    const copy = join(root, "shadow", `${stem}.shots`, "000.jpg");
    expect(readFileSync(copy)).toEqual(JPEG);
    expect(pipeline.shotPath({ ...meta, stem }, 0)).toBe(copy);
    expect(pipeline.shotPath(meta, 0)).toBeNull();
    pipeline.remove({ ...meta, stem });
    expect(existsSync(join(root, "shadow", `${stem}.shots`))).toBe(false);
    expect(existsSync(join(root, "shadow", `${stem}.md`))).toBe(false);
  });
});

describe("the key moments model", () => {
  const line = (id: string, startMs: number, text: string) => ({
    id,
    startMs,
    speaker: "Todd",
    text,
  });

  it("asks Haiku with numbered lines and keeps only moments on the new ones", async () => {
    const argv: string[][] = [];
    const reply = (result: string, code = 0) => ({
      code,
      stdout: JSON.stringify({ result }),
      stderr: "",
      timedOut: false,
    });
    let answer = reply(
      '```json\n{"moments":[{"line":2,"kind":"ask","text":"Send the deck"},{"line":1,"kind":"claim","text":"context"},{"line":9,"kind":"claim","text":"nowhere"}]}\n```',
    );
    const find = claudeFinder({
      claude: "/bin/claude",
      human: "Isaac",
      run: (a, options) => {
        argv.push([...a]);
        expect(options.env).toEqual({ EVA_GATE_OFF: "1" });
        return Promise.resolve(answer);
      },
    });
    const input = {
      context: [line("a", 0, "Morning.")],
      lines: [line("b", 61_000, "Isaac, can you send the deck?")],
      moments: [],
    };
    expect(await find(input)).toEqual([{ lineId: "b", kind: "ask", text: "Send the deck" }]);
    const a = argv[0] ?? [];
    expect(a.slice(0, 2)).toEqual(["/bin/claude", "-p"]);
    expect(a.slice(3)).toEqual([
      "--model",
      "haiku",
      "--tools",
      "",
      "--setting-sources",
      "",
      "--no-session-persistence",
      "--output-format",
      "json",
    ]);
    expect(a[2]).toContain(
      "1. [0:00] Todd: Morning.\n2. [1:01] Todd: Isaac, can you send the deck?",
    );
    expect(a[2]).toContain("Only lines 2 to 2 are new");
    expect(a[2]).not.toContain("\u2014");
    answer = reply("rate limited", 1);
    await expect(find(input)).rejects.toThrow("key moments failed: rate limited");
    answer = reply("I found nothing worth noting.");
    await expect(find(input)).rejects.toThrow("no JSON");
  });

  it("replays a recorded call through the runtime with a fast clock", async () => {
    const lines: LiveLine[] = [0, 20_000, 70_000, 75_000, 150_000].map((startMs, i) => ({
      id: `l${String(i)}`,
      track: "app",
      speaker: "Todd",
      startMs,
      endMs: startMs + 2_000,
      text: [
        "We decide on Postgres.",
        "Okay.",
        "We decide to ship Tuesday.",
        "Okay.",
        "We decide Bill owns the release.",
      ][i] as string,
      final: true,
    }));
    const windows: string[][] = [];
    const moments = await replayKeyMoments(lines, {
      find: decider([]),
      windowMs: 100,
      shots: [{ n: 3, atMs: 140_000 }],
      onExtract: (input) => windows.push(input.lines.map((l) => l.id)),
    });
    expect(windows).toEqual([["l0", "l1"], ["l2", "l3"], ["l4"]]);
    expect(moments.map((m) => [m.id, m.lineId, m.shot])).toEqual([
      ["km0", "l0", null],
      ["km1", "l2", null],
      ["km2", "l4", 3],
    ]);
  });
});

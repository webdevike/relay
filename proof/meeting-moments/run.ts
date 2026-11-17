// Headless end-to-end proof for key moments and screen-share snapshots. Nothing here touches
// Isaac's Relay, Relay Host, Teams or the live helper: everything runs in this process, in temp
// dirs, with the helper in --replay mode (no audio tap, no Screen Recording, no prompts).
//
//   B  snapshots: the real helper replays proof/meeting-share/fixture (a fake 40 s share video),
//      the desktop's share-snapshots runtime decides what to save, the helper uploads over a real
//      ingest WebSocket into a real MeetingsService (temp store), which also gets 45 s of real
//      transcript lines from a recorded call (as the ASR worker would send them) and finds key
//      moments with the real Haiku finder. When the call ends the real MeetingPipeline writes the
//      notes (its ASR answers with those same recorded lines; the summary is real Sonnet).
//   A  key moments: the whole recorded call goes through the real key moments machine and the
//      real Haiku finder (replayKeyMoments, clock sped up 5x), with B's snapshots placed where
//      their 45 s excerpt sits in the call.
//   C  the recorded call's own notes with A's moments and B's snapshots added by the pipeline's
//      section writers, the snapshots copied next to them.
//
// Output goes OUTSIDE the repo (a real call's transcript and moments must never be committed):
// $MEETING_PROOF_OUT, default ~/Eva/work/meeting-moments-proof/out, with `fixture/` laid out for
// the desktop e2e (MEETING_PROOF_DIR=<out>/fixture EVAOS_PROOF=1 pnpm -C apps/desktop e2e
// e2e/meeting-panel.spec.ts draws the Meeting tab from it).
//
//   sh apps/meetings-capture/build.sh
//   bun proof/meeting-moments/run.ts [protocol.txt] [excerpt start m:ss]
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { LiveLine } from "@relay/protocol";
import type { Asr, Segment, WorkerLine } from "../../apps/linux/src/meetings/asr";
import { claudeFinder, replayKeyMoments } from "../../apps/linux/src/meetings/key-moments";
import { keyMomentsSection, MeetingPipeline, shotName, snapshotsSection } from "../../apps/linux/src/meetings/pipeline";
import { MeetingsService, type Conn } from "../../apps/linux/src/meetings/service";
import { RecordingStore, type ShotRow } from "../../apps/linux/src/meetings/store";
import { bunRun, resolveClaude } from "../../apps/linux/src/reviews/exec";
import type { IngestGrant } from "../../apps/linux/src/seams";
import {
  createShareSnapshots,
  parseShareEvent,
  type ShareSnapshots,
} from "../../apps/desktop/src/main/meetings/share-snapshots";

const root = resolve(import.meta.dir, "../..");
const out = process.env["MEETING_PROOF_OUT"] ?? join(homedir(), "Eva/work/meeting-moments-proof/out");
const helper = join(root, "apps/meetings-capture/build/Relay Meetings.app/Contents/MacOS/RelayMeetingCapture");
const fixture = join(root, "proof/meeting-share/fixture");
const txtPath =
  process.argv[2] ?? join(homedir(), "Eva/work/meetings/protocols/20261116_1430_isaac_todd_884eda5e.txt");
const excerptAt = clockMs(process.argv[3] ?? "5:00");
const EXCERPT_MS = 45_000;
const HUMAN = "Isaac";

function clockMs(s: string): number {
  return s.split(":").reduce((acc, p) => acc * 60 + Number(p), 0) * 1000;
}

const log = (s: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

// The recorded call as live lines: "[m:ss] Speaker: text", Isaac's on the mic track.
const lines: LiveLine[] = [];
for (const row of readFileSync(txtPath, "utf8").split("\n")) {
  const m = /^\[(\d+(?::\d+){1,2})\] ([^:]+): (.*)$/.exec(row.trim());
  if (m === null) continue;
  const startMs = clockMs(m[1]!);
  lines.push({
    id: `l${String(lines.length)}`,
    track: m[2] === HUMAN ? "mic" : "app",
    speaker: m[2]!,
    startMs,
    endMs: startMs + 1500,
    text: m[3]!,
    final: true,
  });
}
for (let i = 0; i < lines.length - 1; i++) {
  const next = lines[i + 1]!;
  lines[i] = { ...lines[i]!, endMs: Math.max(lines[i]!.startMs + 500, next.startMs) };
}
const excerpt = lines
  .filter((l) => l.startMs >= excerptAt && l.startMs < excerptAt + EXCERPT_MS)
  .map((l) => ({ ...l, startMs: l.startMs - excerptAt, endMs: l.endMs - excerptAt }));
log(`${basename(txtPath)}: ${String(lines.length)} lines; excerpt ${String(excerpt.length)} lines from ${process.argv[3] ?? "5:00"}`);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "relay-moments-proof-"));
const finder = claudeFinder({ claude: resolveClaude(), run: bunRun, human: HUMAN });
let haikuCalls = 0;

// ------------------------------------------------------------------------------------------
// B: snapshots end to end (plus the live service's own key moments on the excerpt)
// ------------------------------------------------------------------------------------------
const store = new RecordingStore(join(tmp, "recordings"));
const meetingsDir = join(tmp, "eva-meetings");
const segs = (track: "app" | "mic"): Segment[] =>
  excerpt
    .filter((l) => l.track === track)
    .map((l) => ({ start: l.startMs / 1000, end: l.endMs / 1000, text: l.text }));
const asr: Asr = {
  open: () => undefined,
  audio: () => undefined,
  close: () => Promise.resolve(),
  learn: () => undefined,
  // The recording's audio is the fixture's silence: the notes are made from the recorded lines.
  aec: (_app, _mic, outPath) => {
    copyFileSync(join(fixture, "mic.wav"), outPath);
    return Promise.resolve();
  },
  transcribe: (wav) => Promise.resolve(segs(wav.endsWith("app.wav") ? "app" : "mic")),
  diarize: () => Promise.resolve([]),
  stop: () => undefined,
};
const pipeline = new MeetingPipeline({
  store,
  asr,
  agentHome: null,
  meetingsDir,
  human: HUMAN,
  claude: resolveClaude(),
  run: bunRun,
  autoname: () => Promise.resolve(null),
  log,
});
const shareFrames: string[] = [];
const svc = new MeetingsService({
  store,
  asr,
  agentHome: null,
  shadow: false,
  human: HUMAN,
  afterCall: pipeline,
  agents: {
    sessions: [],
    conversation: () => Promise.resolve(null),
    reply: () => Promise.resolve(),
    configure: () => Promise.resolve(),
  },
  launch: null,
  sessionFile: () => null,
  socketPath: join(tmp, "none.sock"),
  broadcast: (m) => {
    if (m.t === "meeting.moments") log(`host: meeting.moments (${String(m.moments.length)})`);
    if (m.t === "meeting.shot") log(`host: meeting.shot n=${String(m.shot.n)} at ${String(m.shot.atMs)} ms`);
    if (m.t === "meeting.recording") {
      const line = `host: recording stage=${m.recording.stage} share=${m.recording.share}`;
      if (shareFrames.at(-1) !== line) shareFrames.push(line);
    }
  },
  push: () => undefined,
  clock: {
    now: () => Date.now(),
    after: (ms, fn) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
  },
  log,
  assistants: () => [],
  findMoments: (input) => {
    haikuCalls += 1;
    return finder(input);
  },
});

const DEVICE = "proof-mac";
type Data = { grant: IngestGrant; conn: Conn | null };
const server = Bun.serve<Data, never>({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname !== "/meetings/ingest") return new Response("not found", { status: 404 });
    const grant = svc.redeem(url.searchParams.get("ticket") ?? "");
    if (grant === null) return new Response("ticket required", { status: 401 });
    return srv.upgrade(req, { data: { grant, conn: null } }) ? undefined : new Response("upgrade", { status: 426 });
  },
  websocket: {
    maxPayloadLength: 16 * 1024 * 1024,
    open(ws) {
      ws.data.conn = svc.connect(ws.data.grant, {
        sendText: (f) => ws.send(JSON.stringify(f)),
        close: (code, reason) => ws.close(code, reason),
      }) as Conn;
    },
    message(ws, msg) {
      if (typeof msg === "string") ws.data.conn?.text(msg);
      else ws.data.conn?.binary(new Uint8Array(msg));
    },
    close(ws) {
      ws.data.conn?.closed();
    },
  },
});

const spool = join(tmp, "spool");
const proc = Bun.spawn([helper, "serve", "--spool", spool, "--replay", fixture, "--no-detect"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "ignore",
});
const send = (cmd: Record<string, unknown>): void => {
  proc.stdin.write(`${JSON.stringify(cmd)}\n`);
};
const helperLog: string[] = [];
let recordingId: string | null = null;
let share: ShareSnapshots | null = null;
let startedAt = 0;
const { promise: uploaded, resolve: onUploaded } = Promise.withResolvers<void>();
const { promise: recordingStarted, resolve: onRecording } = Promise.withResolvers<void>();

void (async () => {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of proc.stdout) {
    buf += dec.decode(chunk);
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      helperLog.push(line);
      const ev = JSON.parse(line) as Record<string, unknown>;
      if (ev["ev"] === "recording" && typeof ev["id"] === "string") {
        recordingId = ev["id"];
        startedAt = Number(ev["startedAt"]);
        const opened = svc.openIngest(DEVICE, "Proof Mac", {
          id: recordingId,
          app: "Microsoft Teams",
          title: "Isaac <> Todd (proof)",
          startedAt,
        });
        if (!("ticket" in opened)) throw new Error(`host refused: ${opened.refused}`);
        send({ cmd: "connect", id: recordingId, url: `ws://127.0.0.1:${String(server.port)}/meetings/ingest?ticket=${opened.ticket}` });
        share = createShareSnapshots({
          id: recordingId,
          percent: 6,
          sendHelper: send,
          sendFrame: (f) => svc.share(DEVICE, f.id, f.state),
          log,
        });
        onRecording();
      }
      const shareEv = parseShareEvent(line);
      if (shareEv !== null) {
        log(`helper: ${line}`);
        share?.heard(shareEv);
      }
      if (ev["ev"] === "stopped") share?.stop();
      if (ev["ev"] === "uploaded") onUploaded();
    }
  }
})();

send({ cmd: "record", app: "Microsoft Teams", title: "Isaac <> Todd (proof)" });
await recordingStarted;
const id = recordingId as unknown as string;
log(`recording ${id}; ingest on :${String(server.port)}`);

// The excerpt's lines reach the host as the ASR worker would send them, at their own times.
for (const l of excerpt) {
  setTimeout(() => {
    const w: WorkerLine = {
      ev: "line",
      meeting: id,
      track: l.track,
      id: l.id,
      start: l.startMs * 16,
      end: l.endMs * 16,
      text: l.text,
      final: true,
    };
    svc.line(w);
  }, l.startMs + 300);
}

await Bun.sleep(EXCERPT_MS);
send({ cmd: "stop", id });
await uploaded;
log("helper: uploaded; after-call running");
for (;;) {
  const m = store.load(id);
  if (m?.stage === "done" || m?.stage === "failed") {
    log(`after-call: ${m.stage}${m.error === null ? "" : ` (${m.error})`}`);
    break;
  }
  await Bun.sleep(1000);
}
send({ cmd: "quit" });
server.stop(true);

const snap = await svc.handle({ kind: "open", id });
const shots = snap.snapshot?.shots ?? [];
const liveMoments = snap.snapshot?.moments ?? [];
const rec = store.load(id)!;
const notesDir = join(meetingsDir, "protocols");
cpSync(notesDir, join(out, "B-pipeline-notes"), { recursive: true });
writeFileSync(join(out, "B-helper-events.jsonl"), `${helperLog.join("\n")}\n`);
writeFileSync(join(out, "B-host-recording.txt"), `${shareFrames.join("\n")}\n`);
writeFileSync(join(out, "B-shots.json"), JSON.stringify(shots, null, 2));
writeFileSync(join(out, "B-live-moments.json"), JSON.stringify(liveMoments, null, 2));
log(`B: ${String(shots.length)} shots, ${String(liveMoments.length)} live moments, notes ${rec.stem ?? "none"}`);

// ------------------------------------------------------------------------------------------
// A: the whole call through the key moments machine and Haiku
// ------------------------------------------------------------------------------------------
const shotRows = readFileSync(join(store.dir(id), "shots.jsonl"), "utf8")
  .split("\n")
  .filter((r) => r.trim() !== "")
  .map((r) => JSON.parse(r) as ShotRow | null)
  .filter((r): r is ShotRow => r !== null);
// B's excerpt sits at `excerptAt` in the call: its snapshots go there too.
const placed = shotRows.map((s) => ({ ...s, atMs: s.atMs + excerptAt }));
const windows: number[] = [];
const t0 = Date.now();
const moments = await replayKeyMoments(lines, {
  find: (input) => {
    windows.push(input.lines.length);
    return finder(input);
  },
  windowMs: 9_000,
  shots: placed,
  log,
});
log(`A: ${String(moments.length)} moments from ${String(windows.length)} Haiku calls in ${String(Math.round((Date.now() - t0) / 1000))} s`);
writeFileSync(join(out, "A-moments.json"), JSON.stringify(moments, null, 2));
writeFileSync(
  join(out, "A-stats.json"),
  JSON.stringify({ transcript: basename(txtPath), lines: lines.length, calls: windows.length, linesPerCall: windows, moments: moments.length }, null, 2),
);

// ------------------------------------------------------------------------------------------
// C: the recorded call's notes with both sections, snapshots next to them
// ------------------------------------------------------------------------------------------
const stem = basename(txtPath, ".txt");
const recordedMd = readFileSync(txtPath.replace(/\.txt$/, ".md"), "utf8");
const cut = recordedMd.indexOf("\n---\n\n## Full Transcript");
const sections = [keyMomentsSection(moments, stem, placed), snapshotsSection(placed, stem)].filter((s) => s !== "").join("\n");
const md = cut < 0 ? `${recordedMd}\n${sections}` : `${recordedMd.slice(0, cut)}\n${sections}${recordedMd.slice(cut)}`;
const cDir = join(out, "C-notes");
mkdirSync(join(cDir, `${stem}.shots`), { recursive: true });
writeFileSync(join(cDir, `${stem}.md`), md);
for (const s of placed) copyFileSync(join(store.dir(id), "shots", `${String(s.n)}.jpg`), join(cDir, `${stem}.shots`, shotName(s.n)));

// The desktop e2e fixture (apps/desktop/e2e/helpers/meeting-proof.ts) from the real output.
const fx = join(out, "fixture");
rmSync(fx, { recursive: true, force: true });
mkdirSync(join(fx, "shots"), { recursive: true });
writeFileSync(join(fx, "lines.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
writeFileSync(join(fx, "moments.json"), JSON.stringify({ moments, through: lines.at(-1)?.startMs ?? 0 }, null, 2));
writeFileSync(join(fx, "shots.jsonl"), `${placed.map((s) => JSON.stringify(s)).join("\n")}\n`);
for (const s of placed) copyFileSync(join(store.dir(id), "shots", `${String(s.n)}.jpg`), join(fx, "shots", `${String(s.n)}.jpg`));

rmSync(tmp, { recursive: true, force: true });
log(`done: ${out}`);
process.exit(0);

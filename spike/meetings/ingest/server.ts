// Spike stand-in for Relay Host's meeting ingest socket: takes the capture helper's frames
// (text: meeting.hello / meeting.end JSON; binary: u8 track, i64 LE first sample, s16 LE PCM),
// writes one WAV per track and reports arrival timing.
//   bun server.ts <out dir> [port]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2] ?? "ingest-out";
const port = Number(process.argv[3] ?? 7899);
mkdirSync(out, { recursive: true });

const TRACKS = ["app", "mic"] as const;
type Stat = { frames: number; samples: number; gaps: number; arrivals: number[] };
const pcm: Record<number, Buffer[]> = { 0: [], 1: [] };
const stats: Record<number, Stat> = {
  0: { frames: 0, samples: 0, gaps: 0, arrivals: [] },
  1: { frames: 0, samples: 0, gaps: 0, arrivals: [] },
};
let openedAt = 0;

function wav(samples: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + samples.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(samples.length, 40);
  return Buffer.concat([h, samples]);
}

function finish(summary: unknown): void {
  const report: Record<string, unknown> = { helper: summary };
  for (const t of [0, 1]) {
    const s = stats[t]!;
    const gaps = s.arrivals.slice(1).map((a, i) => a - s.arrivals[i]!);
    gaps.sort((a, b) => a - b);
    writeFileSync(join(out, `${TRACKS[t]}.wav`), wav(Buffer.concat(pcm[t]!)));
    report[TRACKS[t]] = {
      frames: s.frames,
      seconds: s.samples / 16000,
      sampleIndexGaps: s.gaps,
      interArrivalMsP50: gaps[Math.floor(gaps.length / 2)] ?? null,
      interArrivalMsP99: gaps[Math.floor(gaps.length * 0.99)] ?? null,
    };
  }
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report));
  process.exit(0);
}

Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(req, srv) {
    if (new URL(req.url).pathname === "/meetings/ingest" && srv.upgrade(req)) return undefined;
    return new Response("no", { status: 404 });
  },
  websocket: {
    open() {
      openedAt = performance.now();
    },
    message(_ws, raw) {
      if (typeof raw === "string") {
        const msg = JSON.parse(raw) as { t: string };
        console.log(raw.slice(0, 300));
        if (msg.t === "meeting.end") finish(msg);
        return;
      }
      const b = Buffer.from(raw);
      const track = b.readUInt8(0);
      const at = Number(b.readBigInt64LE(1));
      const s = stats[track]!;
      if (at !== s.samples) s.gaps++;
      const body = b.subarray(9);
      pcm[track]!.push(Buffer.from(body));
      s.frames++;
      s.samples += body.length / 2;
      s.arrivals.push(performance.now() - openedAt);
    },
  },
});
console.log(`ingest on ws://127.0.0.1:${port}/meetings/ingest -> ${out}`);

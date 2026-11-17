// Replay smoke for the capture helper's screen-share snapshots: runs the built helper on the
// fixture (no audio tap, no Screen Recording, no prompts), samples the shared screen at set
// replay times, saves the first sample of each slide, and prints the events, the OCR text and the
// hash distances between same-slide and different-slide samples (the change threshold's
// calibration).
//
//   python3 proof/meeting-share/make-fixture.py
//   sh apps/meetings-capture/build.sh
//   bun proof/meeting-share/smoke.ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const helper = join(root, "apps/meetings-capture/build/Relay Meetings.app/Contents/MacOS/RelayMeetingCapture");
const fixture = join(import.meta.dir, "fixture");
const spool = mkdtempSync(join(tmpdir(), "relay-share-smoke-"));

// Replay seconds to sample at, the slide on screen then, and whether to save it.
const plan: { at: number; slide: string; save: boolean }[] = [
  { at: 1, slide: "-", save: false },
  { at: 4, slide: "A", save: true },
  { at: 8, slide: "A", save: false },
  { at: 12, slide: "A", save: false },
  { at: 16, slide: "B", save: true },
  { at: 20, slide: "B", save: false },
  { at: 25, slide: "B", save: false },
  { at: 30, slide: "C", save: true },
  { at: 35, slide: "C", save: false },
  { at: 39, slide: "-", save: false },
];

type Ev = Record<string, unknown> & { ev: string };
const proc = Bun.spawn([helper, "serve", "--spool", spool, "--replay", fixture, "--no-detect"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
});
const waiters: { test: (e: Ev) => boolean; done: (e: Ev) => void }[] = [];
let t0 = 0;

(async () => {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of proc.stdout) {
    buf += decoder.decode(chunk);
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const e = JSON.parse(line) as Ev;
      console.log(`[${t0 ? ((Date.now() - t0) / 1000).toFixed(1).padStart(5) : "  -  "}] ${line}`);
      for (const w of waiters.splice(0)) {
        if (w.test(e)) w.done(e);
        else waiters.push(w);
      }
    }
  }
})();

const next = (test: (e: Ev) => boolean) => new Promise<Ev>((done) => waiters.push({ test, done }));
const send = (obj: object) => {
  console.log(`[${t0 ? ((Date.now() - t0) / 1000).toFixed(1).padStart(5) : "  -  "}] > ${JSON.stringify(obj)}`);
  proc.stdin.write(`${JSON.stringify(obj)}\n`);
  proc.stdin.flush();
};

await next((e) => e.ev === "ready");
send({ cmd: "record", app: "Microsoft Teams", title: "Share smoke" });
const rec = await next((e) => e.ev === "recording");
t0 = Date.now();
const id = rec.id as string;

const hashes: { seq: number; at: number; slide: string; hash: string }[] = [];
for (const [seq, step] of plan.entries()) {
  await Bun.sleep(Math.max(0, t0 + step.at * 1000 - Date.now()));
  send({ cmd: "share.sample", id, seq });
  const r = await next((e) => (e.ev === "share.sampled" || e.ev === "share.sample.failed") && e.seq === seq);
  if (r.ev === "share.sampled") hashes.push({ seq, at: step.at, slide: step.slide, hash: r.hash as string });
  if (step.save && r.ev === "share.sampled") {
    send({ cmd: "share.save", id, seq });
    await next((e) => (e.ev === "share.saved" || e.ev === "share.save.failed") && e.seq === seq);
  }
}
// A save of a frame that is not held fails.
send({ cmd: "share.save", id, seq: 99 });
await next((e) => e.ev === "share.save.failed" && e.seq === 99);
send({ cmd: "stop", id });
await next((e) => e.ev === "stopped");
send({ cmd: "quit" });
await proc.exited;

const bits = (a: string, b: string) =>
  [...a].reduce((n, c, i) => n + ((parseInt(c, 16) ^ parseInt(b[i]!, 16)).toString(2).match(/1/g)?.length ?? 0), 0);
console.log("\nHash distances (bits of 256, percent):");
const same: number[] = [];
const diff: number[] = [];
for (let i = 0; i < hashes.length; i++) {
  for (let j = i + 1; j < hashes.length; j++) {
    const a = hashes[i]!;
    const b = hashes[j]!;
    const d = bits(a.hash, b.hash);
    (a.slide === b.slide ? same : diff).push(d);
    console.log(`  ${a.at}s(${a.slide}) vs ${b.at}s(${b.slide}): ${d} bits = ${((d / 256) * 100).toFixed(1)}%`);
  }
}
const sameMax = Math.max(...same);
const diffMin = Math.min(...diff);
console.log(
  `same slide: max ${sameMax} bits (${((sameMax / 256) * 100).toFixed(1)}%); different slides: min ${diffMin} bits (${((diffMin / 256) * 100).toFixed(1)}%)`,
);

console.log("\nshots.jsonl:");
const shots = readFileSync(join(spool, id, "shots.jsonl"), "utf8").trim().split("\n");
for (const l of shots) {
  const s = JSON.parse(l) as { n: number; at: number; w: number; h: number; hash: string; ocr: string };
  console.log(`  #${s.n} at=${s.at} (${(s.at / 16000).toFixed(1)} s) ${s.w}x${s.h} hash=${s.hash}`);
  console.log(`    ocr: ${JSON.stringify(s.ocr)}`);
}
console.log(`\nspool: ${join(spool, id)}`);

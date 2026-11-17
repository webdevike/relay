// Headless end-to-end proof of trial mode on real parts, in a scratch home (never Isaac's):
// - the real atomic-agents service (`bun packages/atomic-agents/src/cli.ts serve`) on real models,
// - the real Relay Host trial code (apps/linux/src/trials: SpecialistRunBook + TrialService, the same objects
//   main.ts builds), its `trials.snapshot` frames recorded as a device would get them,
// - a simulated Isaac who prefers Haiku: he picks the letter behind it on 8 of 10 cards (one Sonnet, one "can't tell").
// Checks: 3 results stream in one by one; the caller's answer comes from the agent's own model before the slowest arm;
// no model name on a card before the pick, revealed after; every pick on the bench; the agent switches on its own with
// its message; Undo puts the old model and the trial back.
//
//   OMP_PROFILE=personal bun proof/trial-mode/e2e.ts
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage, Trial, TrialsSnapshot } from "@relay/protocol";
import { SpecialistRunBook } from "../../apps/linux/src/assistant/specialist-runs";
import { TrialService } from "../../apps/linux/src/trials/service";

const REPO = join(import.meta.dir, "../..");
const CLI = join(REPO, "packages/atomic-agents/src/cli.ts");
const OUT = import.meta.dir;
const AGENT = "anti-average";
const HAIKU = "anthropic/claude-haiku-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";

const home = mkdtempSync(join(tmpdir(), "trial-proof-"));
const env = { ...process.env, ATOMIC_AGENTS_HOME: home, OMP_PROFILE: process.env["OMP_PROFILE"] ?? "personal" };
const t0 = Date.now();
const lines: string[] = [];
const log = (line: string) => {
  const stamped = `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${line}`;
  lines.push(stamped);
  console.log(stamped);
};
const fail = (why: string): never => {
  log(`FAIL: ${why}`);
  writeFileSync(join(OUT, "e2e-output.txt"), `${lines.join("\n")}\n`);
  process.exit(1);
};
const check = (ok: boolean, what: string) => (ok ? log(`ok   ${what}`) : fail(what));
const cli = (args: string[]) => {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = spawn("bun", [CLI, ...args], { env });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`cli ${args.join(" ")} exited ${code}`))));
  return promise;
};
const journal = () =>
  existsSync(join(home, "events.ndjson"))
    ? readFileSync(join(home, "events.ndjson"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; at: string; data: Record<string, unknown> })
    : [];
const config = () => JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as {
  components?: Record<string, Record<string, unknown>>;
};
const waitFor = async <T>(what: string, probe: () => T | undefined, ms = 240_000): Promise<T> => {
  const until = Date.now() + ms;
  for (;;) {
    const found = probe();
    if (found !== undefined) return found;
    if (Date.now() > until) return fail(`timed out waiting for ${what}`);
    await Bun.sleep(250);
  }
};

// Only anti-average runs here: every other agent (crons included) is off in this scratch home.
const ids = (JSON.parse(await cli(["catalog"])) as Array<{ id: string }>).map((agent) => agent.id);
writeFileSync(
  join(home, "config.json"),
  `${JSON.stringify({ components: Object.fromEntries(ids.filter((id) => id !== AGENT).map((id) => [id, { enabled: false }])) }, null, 2)}\n`,
);
log(`scratch home ${home}`);

const service = spawn("bun", [CLI, "serve"], { env });
let serviceLog = "";
service.stdout.on("data", (chunk) => (serviceLog += chunk));
service.stderr.on("data", (chunk) => (serviceLog += chunk));
await waitFor("the service", () => (serviceLog.includes("atomic-agents serving") ? true : undefined), 60_000);
log("atomic-agents service up (real CLI serve, real models through omp)");

// The host side, as main.ts wires it, with a recorder for what every device receives.
const frames: Array<{ at: number; snapshot: TrialsSnapshot }> = [];
const book = new SpecialistRunBook(home, 200);
const host = new TrialService({
  home,
  book,
  broadcast: (message: ServerMessage) => {
    if (message.t === "trials.snapshot") frames.push({ at: Date.now() - t0, snapshot: { trials: message.trials, switches: message.switches } });
  },
  log: (line) => log(`host: ${line}`),
});
await host.snapshot();

const briefs = [
  "a name for a tiny bakery that only sells sourdough",
  "a name for a podcast about restoring old boats",
  "a tagline for a bike repair cart that comes to your office",
  "a name for a dog-walking app for rainy cities",
  "a name for a board game about lighthouse keepers",
  "a tagline for a library of tools you can borrow",
  "a name for a newsletter about weird maps",
  "a name for a coffee cart at a ferry terminal",
  "a tagline for a night market of local makers",
  "a name for a houseplant hospital",
];
const ask = async (brief: string) => {
  const answer = JSON.parse(
    await cli(["request", AGENT, JSON.stringify({ kind: "name", brief, count: 3 }), "--wait", "1ms", "--caller", "agent:nova"]),
  ) as { run: string };
  return answer.run;
};

// 1. One request, watched closely.
const first = await ask(briefs[0]!);
log(`asked ${AGENT} for "${briefs[0]}" as agent:nova (request ${first})`);
const started = await waitFor("trial.started", () =>
  journal().find((event) => event.type === `${AGENT}/trial.started` && event.data["requestId"] === first),
);
const trialId = started.data["trialId"] as string;
const arms = started.data["arms"] as Array<{ letter: string; model: string; label: string; default: boolean }>;
log(`trial ${trialId}: ${arms.map((arm) => `${arm.letter}=${arm.label}${arm.default ? " (its own model)" : ""}`).join(", ")} [journal only, never on the card]`);
check(arms.length === 3 && arms.filter((arm) => arm.default).length === 1, "three models at once, one of them the agent's own");

const cardOf = (id: string) => [...frames].reverse().map((frame) => frame.snapshot.trials.find((trial) => trial.id === id)).find(Boolean);
const shownStates = new Set<string>();
await waitFor("all three results on the card", () => {
  const card = cardOf(trialId);
  if (card === undefined) return undefined;
  const state = card.arms.map((arm) => `${arm.letter}:${arm.status}`).join(" ");
  if (!shownStates.has(state)) {
    shownStates.add(state);
    log(`card ${state}`);
  }
  return card.arms.every((arm) => arm.status !== "running") ? card : undefined;
});
check(shownStates.size >= 3, `results arrived one by one (${shownStates.size} distinct card states)`);
const events = journal();
const results = events.filter((event) => event.type === `${AGENT}/trial.result` && event.data["trialId"] === trialId);
const reply = events.find((event) => event.type === `${AGENT}/creative.options` && event.data["requestId"] === first);
const ownLetter = arms.find((arm) => arm.default)!.letter;
check(reply !== undefined && reply.data["model"] === SONNET, "the caller got its answer from the agent's own model");
check(
  Date.parse(reply!.at) <= Date.parse(results[results.length - 1]!.at),
  `the answer did not wait for the slowest arm (answer at ${reply!.at.slice(11, 19)}, last arm at ${results[results.length - 1]!.at.slice(11, 19)}; own arm ${ownLetter})`,
);
check(
  events.filter((event) => event.type === `${AGENT}/creative.options`).length === 1,
  "the other arms never answered the caller (one creative.options on the journal)",
);
const blind = JSON.stringify(cardOf(trialId));
check(
  !arms.some((arm) => blind.includes(arm.model) || blind.includes(arm.label)),
  "no model id or name anywhere on the card before the pick",
);

// 2. Nine more requests at once.
const rest = await Promise.all(briefs.slice(1).map(ask));
log(`asked 9 more at once: ${rest.length} requests`);
const all = [first, ...rest];
const trialOf = (requestId: string) =>
  journal().find((event) => event.type === `${AGENT}/trial.started` && event.data["requestId"] === requestId);
const ready = (id: string) => {
  const card = cardOf(id);
  return card !== undefined && card.arms.filter((arm) => arm.status === "done").length >= 2 ? card : undefined;
};

// 3. Isaac's taste: Sonnet once, can't tell once, then Haiku eight times.
const plan = ["sonnet", "unsure", ...Array(8).fill("haiku")] as const;
for (const [index, requestId] of all.entries()) {
  const start = await waitFor(`trial for ${requestId}`, () => trialOf(requestId));
  const id = start.data["trialId"] as string;
  const card: Trial = await waitFor(`card ${id} finished`, () => {
    const found = ready(id);
    return found !== undefined && found.arms.every((arm) => arm.status !== "running") ? found : undefined;
  });
  const want = plan[index]!;
  const behind = (start.data["arms"] as typeof arms).find((arm) => arm.model === (want === "haiku" ? HAIKU : SONNET));
  const pick = want === "unsure" ? "unsure" : behind!.letter;
  const answer = await host.pick(id, pick as "A" | "B" | "C" | "unsure", "phone");
  check(answer.ok, `pick ${index + 1}: ${pick} on card ${id.slice(0, 8)} (${want})`);
  const revealed = await waitFor("the revealed card", () => {
    const after = cardOf(id);
    return after?.pick !== undefined && after.arms.every((arm) => arm.modelLabel !== undefined) ? after : undefined;
  });
  if (index === 0)
    log(`revealed: ${revealed.arms.map((arm) => `${arm.letter}=${arm.modelLabel}`).join(", ")}; picked ${revealed.pick}`);
  void card;
}

// 4. The bench and the switch.
const bench = await waitFor("10 picks on the bench", () => {
  const file = join(home, "bench", AGENT, "trials.jsonl");
  if (!existsSync(file)) return undefined;
  const rows = readFileSync(file, "utf8").trim().split("\n");
  return rows.length >= 10 ? rows.map((row) => JSON.parse(row) as { pick: string; winner: string | null }) : undefined;
});
check(bench.length === 10, `bench ${join("bench", AGENT, "trials.jsonl")}: ${bench.map((row) => row.winner?.split("/")[1] ?? "can't tell").join(", ")}`);
const switched = await waitFor("the agent's own switch", () => {
  const snapshot = frames[frames.length - 1]?.snapshot;
  return snapshot?.switches.find((entry) => entry.agent === AGENT);
});
log(`switch message (thread ${switched.thread}): "${switched.text}"`);
check(switched.to === HAIKU && !switched.kept && switched.thread === "assistant:nova", "switched to Haiku, shown in Nova's chat");
check(
  config().components?.[AGENT]?.["model"] === HAIKU && config().components?.[AGENT]?.["trial"] === false,
  "config.json: model Haiku, trial off",
);

// 5. Undo.
const undone = await host.undo(switched.id);
check(undone.ok, "Undo accepted");
await waitFor("config back", () => {
  const own = config().components?.[AGENT] ?? {};
  return own["model"] === undefined && own["trial"] === undefined ? true : undefined;
}, 30_000);
check(true, "config.json: back on the agent's own model (Sonnet 5.5), trial on again (agent file default)");
const after = await waitFor("undone on the card", () => frames[frames.length - 1]?.snapshot.switches.find((entry) => entry.id === switched.id && entry.undone));
check(after.undone, "the switch message shows it was undone");

writeFileSync(join(OUT, "frames.json"), `${JSON.stringify(frames, null, 2)}\n`);
writeFileSync(join(OUT, "e2e-output.txt"), `${lines.join("\n")}\n`);
log(`PASS (${frames.length} trials.snapshot frames recorded)`);
host.close();
service.kill("SIGTERM");
process.exit(0);

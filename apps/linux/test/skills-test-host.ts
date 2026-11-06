// A throwaway Relay host for Relay Desktop's Skills e2e and proof runs: the real `/skills` routes
// and live rooms (http.ts, service.ts, room.ts) over a temp home holding one skill, on loopback.
// Comments are delivered to `--agent`:
//   script  answers from a playbook (JSON: [{match, reply?, edit?}]), through the same HTTP routes
//           the CLI uses (`/skills/<name>/reply`, `/skills/<name>/edit`), as Nova;
//   omp     hands the delivered text to a real `omp -p` run whose `relay-linux skills ...` calls
//           reach this host (RELAY_HOST_URL) through this checkout's CLI.
// Prints `listening <port>` once up. Never touches the real ~/.omp or ~/Eva.
//
//   bun apps/linux/test/skills-test-host.ts --skill demo --file <SKILL.md> [--agent script --playbook <json>] [--agent omp]

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { ServerWebSocket } from "bun";
import { docThreadsOf, snapDocThreads } from "@relay/canvas-live/doc-threads";
import type { CanvasPeer } from "../src/canvas/room";
import { SkillCatalog } from "../src/skills/catalog";
import { authorizeSkillSocket, handleSkillsRequest } from "../src/skills/http";
import type { SkillRoom } from "../src/skills/room";
import { SkillsService } from "../src/skills/service";
import { SkillUsageIndex } from "../src/skills/usage";
import { skillsHome } from "./skills-home";

const { values } = parseArgs({
  options: {
    skill: { type: "string", default: "demo" },
    file: { type: "string" },
    agent: { type: "string", default: "script" },
    playbook: { type: "string" },
    model: { type: "string", default: "anthropic/claude-sonnet-5-5" },
  },
});
const name = values.skill;
const home = skillsHome();
home.write(`Eva/.omp/skills/${name}/SKILL.md`, values.file === undefined ? `---\nname: ${name}\ndescription: Demo skill\n---\n\n# ${name}\n\nBody.\n` : readFileSync(values.file, "utf8"));
home.listed.push({ name, dir: `Eva/.omp/skills/${name}`, source: "native:project" });

interface Play {
  /** Regex (case-insensitive) on the comment's text. */
  match: string;
  reply?: string;
  /** find: "quote" replaces the commented text. */
  edit?: { find?: string; replace?: string; after?: string; insert?: string };
  /** Milliseconds before acting, so a reader sees the assistant at work. */
  delay?: number;
}
const playbook: Play[] = values.playbook === undefined ? [] : (JSON.parse(readFileSync(values.playbook, "utf8")) as Play[]);

let port = 0;
const CHECKOUT_CLI = resolve(import.meta.dir, "../src/main.ts");
const post = async (path: string, body: unknown): Promise<void> => {
  const response = await fetch(`http://127.0.0.1:${String(port)}/skills/${encodeURIComponent(name)}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) console.error(`agent: ${path} -> ${String(response.status)} ${await response.text()}`);
};

/** The playbook's answer to the comment just delivered in `text`. */
async function scripted(skills: SkillsService, text: string): Promise<void> {
  const thread = /comment thread (\S+?)[ ,.]/.exec(text)?.[1];
  const comment = /^\[Skill comment from [^\]]+\] (.*)$/m.exec(text)?.[1] ?? "";
  if (thread === undefined) return;
  const play = playbook.find((p) => new RegExp(p.match, "i").test(comment));
  if (play === undefined) return;
  await Bun.sleep(play.delay ?? 600);
  const quote = snapDocThreads(docThreadsOf(skills.room(name).sync.doc)).find((t) => t.id === thread)?.quote ?? "";
  if (play.edit !== undefined) {
    const { find, replace, after, insert } = play.edit;
    await post("edit", { as: "Nova", thread, ...(after === undefined ? { find: find === "quote" ? quote : find, replace } : { after, insert }) });
  }
  if (play.reply !== undefined) await post("reply", { as: "Nova", thread, text: play.reply });
}

/** A real omp run on the delivered text, its CLI calls (this checkout's) reaching this host. */
function viaOmp(text: string): Promise<undefined> {
  const { promise, resolve: done, reject: fail } = Promise.withResolvers<undefined>();
  const child = spawn("omp", ["-p", "--model", values.model, text], { env: { ...process.env, RELAY_HOST_URL: `http://127.0.0.1:${String(port)}` }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk: Buffer) => process.stdout.write(`omp: ${chunk.toString()}`));
  child.stderr.on("data", (chunk: Buffer) => process.stderr.write(`omp: ${chunk.toString()}`));
  child.on("error", fail);
  child.on("close", () => {
    done(undefined);
  });
  return promise;
}

const usage = new SkillUsageIndex({ home: home.home, agentHome: home.evaRoot, assistantsDir: null, cacheFile: null, logFile: null });
const skills: SkillsService = new SkillsService({
  catalog: new SkillCatalog({ home: home.home, evaRoot: home.evaRoot, run: home.run, list: home.list }),
  usage,
  threadsDir: join(home.home, "skill-threads"),
  cli: `bun ${CHECKOUT_CLI}`,
  deliver: (assistant, text) => {
    process.stdout.write(`deliver to ${assistant}:\n${text}\n\n`);
    // The real host hands the turn over and returns; the answer arrives later through the routes.
    void (values.agent === "omp" ? viaOmp(text) : scripted(skills, text)).catch((error: unknown) => {
      console.error(`agent failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return Promise.resolve();
  },
  log: (line) => {
    process.stdout.write(`${line}\n`);
  },
});
await skills.refresh();

interface Data {
  room: SkillRoom;
  peer: CanvasPeer | null;
}
const server = Bun.serve<Data>({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, srv) {
    const path = new URL(request.url).pathname;
    const remote = srv.requestIP(request)?.address ?? "";
    const room = authorizeSkillSocket(skills, request, path, remote);
    if (room instanceof Response) return room;
    if (room !== null) return srv.upgrade(request, { data: { room, peer: null } }) ? undefined : new Response("upgrade required", { status: 426 });
    return handleSkillsRequest(skills, request, path, remote);
  },
  websocket: {
    open(ws: ServerWebSocket<Data>) {
      const peer: CanvasPeer = {
        send: (data) => {
          ws.sendBinary(data);
        },
        close: (code, reason) => {
          ws.close(code, reason);
        },
      };
      ws.data.peer = peer;
      skills.connect(ws.data.room, peer);
    },
    message(ws: ServerWebSocket<Data>, raw) {
      if (ws.data.peer !== null && typeof raw !== "string") ws.data.room.sync.receive(ws.data.peer, new Uint8Array(raw));
    },
    close(ws: ServerWebSocket<Data>) {
      if (ws.data.peer !== null) skills.disconnect(ws.data.room, ws.data.peer);
    },
  },
});
port = server.port ?? 0;
process.stdout.write(`listening ${String(port)} skill ${join(home.evaRoot, ".omp/skills", name, "SKILL.md")}\n`);

const stop = (): void => {
  skills.stop();
  void server.stop(true);
  home.cleanup();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

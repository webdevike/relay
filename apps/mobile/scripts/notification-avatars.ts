// Renders each registry assistant's portrait, as the app draws it (src/lib/portrait.ts on its paper
// disc), into targets/notification-service/avatar-<id>.png: the sender image of its Communication
// Notifications. Rerun after a portrait changes in agents.json, then rebuild the app.
//   bun scripts/notification-avatars.ts [path/to/agents.json]   (default ~/Eva/.omp/assistant/agents.json)
// macOS only: `sips` rasterizes the SVG.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantPortrait } from "@relay/protocol";
import { portraitOf, portraitSvg } from "../src/lib/portrait";

/** Pixels per side; iOS crops it to a circle. */
const SIZE = 256;
/** `palettes.light.surfaceRaised` (src/theme.ts), the paper of a portrait without its own. */
const PAPER = "#EDEDF1";

interface Entry {
  id: string;
  avatar?: string | AssistantPortrait;
}

const registry = process.argv[2] ?? join(homedir(), "Eva", ".omp", "assistant", "agents.json");
const { agents } = JSON.parse(readFileSync(registry, "utf8")) as { agents: Entry[] };
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "targets", "notification-service");
const scratch = mkdtempSync(join(tmpdir(), "relay-avatars-"));
try {
  for (const agent of agents) {
    const portrait = portraitOf(typeof agent.avatar === "object" ? { id: agent.id, portrait: agent.avatar } : { id: agent.id, avatar: agent.avatar });
    const drawn = portraitSvg(portrait);
    const open = /^<svg[^>]*>/.exec(drawn)?.[0];
    if (open === undefined) throw new Error(`${agent.id}: portrait is not an SVG`);
    const [x = 0, y = 0, w = 360, h = 360] = (/viewBox="([^"]+)"/.exec(open)?.[1] ?? "").split(/[\s,]+/).map(Number);
    const paper = portrait.colors?.paper ?? PAPER;
    const sized = open.replace(/\s(width|height)="[^"]*"/g, "").replace(/^<svg/, `<svg width="${SIZE}" height="${SIZE}"`);
    const svg = `${sized}<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${paper}"/>${drawn.slice(open.length)}`;
    const source = join(scratch, `${agent.id}.svg`);
    writeFileSync(source, svg);
    const target = join(out, `avatar-${agent.id}.png`);
    execFileSync("sips", ["-s", "format", "png", source, "--out", target], { stdio: "ignore" });
    console.log(`${agent.id}: ${target}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

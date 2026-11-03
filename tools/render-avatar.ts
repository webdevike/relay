// Draws one assistant portrait as SVG, exactly as Relay does (apps/mobile/src/lib/portrait.ts
// portraitSvg): the registry's DiceBear style, seed and part options on a transparent background.
// Usage: bun render-avatar.ts '<portrait json>'  (prints the SVG). The DiceBear packages come from
// Relay's checkout ($RELAY_DIR, default ~/Eva/work/relay), so both draw with the same generator.
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const relay = process.env["RELAY_DIR"] ?? join(homedir(), "Eva/work/relay");
const require = createRequire(join(relay, "package.json"));
const { createAvatar } = require("@dicebear/core");
const styles: Record<string, unknown> = { micah: require("@dicebear/micah"), notionists: require("@dicebear/notionists") };

const portrait = JSON.parse(process.argv[2] ?? "{}") as { style?: string; seed?: string; options?: Record<string, unknown> };
const style = styles[portrait.style ?? "notionists"];
if (style === undefined || portrait.seed === undefined) {
  console.error(`render-avatar: unsupported portrait ${process.argv[2] ?? ""}`);
  process.exit(1);
}
const svg = createAvatar(style, { ...portrait.options, seed: portrait.seed, backgroundColor: ["transparent"] })
  .toString()
  .replace(/<metadata[\s\S]*?<\/metadata>/, "");
process.stdout.write(svg);

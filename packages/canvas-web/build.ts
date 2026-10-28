// Bundles the live canvas client (src/main.tsx with React, React Flow, Yjs, y-websocket and its
// CSS) into generated/canvas.html: one self-contained page, scripts and styles inline, that the
// Relay host embeds as text and serves at /canvas/<slug>/?token=….
// Run after changing src/ or a dependency: `bun run build` in packages/canvas-web.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const result = await Bun.build({
	entrypoints: [join(here, "src", "main.tsx")],
	target: "browser",
	format: "esm",
	minify: true,
	define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
let js = "";
let css = "";
for (const out of result.outputs) {
	if (out.path.endsWith(".js")) js += await out.text();
	else if (out.path.endsWith(".css")) css += await out.text();
}
if (!js) throw new Error("Bun.build produced no script");
// Inlined in <script>/<style> elements: nothing may close them early.
js = js.replaceAll("</script", "<\\/script");
css = css.replaceAll("</style", "<\\/style");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-visual">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:,">
<title>Live canvas</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script type="module">${js}</script>
</body>
</html>
`;
const out = join(here, "generated", "canvas.html");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`wrote ${out}: ${(html.length / 1024).toFixed(0)} KB (js ${(js.length / 1024).toFixed(0)} KB, css ${(css.length / 1024).toFixed(0)} KB)`);

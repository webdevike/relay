// Bundles the canvas-web pages, each into one self-contained HTML file (scripts and styles inline)
// that the Relay host embeds as text:
// - generated/canvas.html: the live canvas client (src/main.tsx with React, React Flow, Yjs,
//   y-websocket and its CSS), served at /canvas/<slug>/?token=….
// - generated/share.html: a shared board page (src/share/main.tsx), served at /share/<token>. The
//   host fills SHARE_DATA_SLOT with the page's JSON and SHARE_RUNTIME_SLOT with the Mantine runtime
//   (only when the page has a Mantine tile).
// Run after changing src/ or a dependency: `bun run build` in packages/canvas-web.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SHARE_DATA_SLOT, SHARE_RUNTIME_SLOT } from "./src/share/slots";

const here = dirname(fileURLToPath(import.meta.url));

/** The bundled script and CSS of `entry`, safe to inline in <script>/<style> elements. */
async function bundle(entry: string): Promise<{ js: string; css: string }> {
  const result = await Bun.build({
    entrypoints: [join(here, "src", entry)],
    target: "browser",
    format: "esm",
    minify: true,
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    plugins: [
      {
        // One Yjs in the page: canvas-live's helpers (threads.ts) import it from their own package,
        // and a second copy breaks Yjs' type checks (the doc's maps would not be its Y.Map).
        name: "one-yjs",
        setup(build) {
          const yjs = Bun.resolveSync("yjs", here);
          build.onResolve({ filter: /^yjs$/ }, () => ({ path: yjs }));
        },
      },
    ],
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
  if (!js) throw new Error(`Bun.build produced no script for ${entry}`);
  // Inlined in <script>/<style> elements: nothing may close them early.
  return {
    js: js.replaceAll("</script", "<\\/script"),
    css: css.replaceAll("</style", "<\\/style"),
  };
}

function write(name: string, html: string, { js, css }: { js: string; css: string }): void {
  const out = join(here, "generated", name);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  console.log(
    `wrote ${out}: ${(html.length / 1024).toFixed(0)} KB (js ${(js.length / 1024).toFixed(0)} KB, css ${(css.length / 1024).toFixed(0)} KB)`,
  );
}

const canvas = await bundle("main.tsx");
write(
  "canvas.html",
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-visual">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:,">
<title>Live canvas</title>
<style>${canvas.css}</style>
</head>
<body>
<div id="root"></div>
<script type="module">${canvas.js}</script>
</body>
</html>
`,
  canvas,
);

const share = await bundle("share/main.tsx");
write(
  "share.html",
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<link rel="icon" href="data:,">
<title>Shared board</title>
${SHARE_RUNTIME_SLOT}
<style>${share.css}</style>
</head>
<body>
<div id="root"></div>
<script id="relay-share" type="application/json">${SHARE_DATA_SLOT}</script>
<script type="module">${share.js}</script>
</body>
</html>
`,
  share,
);

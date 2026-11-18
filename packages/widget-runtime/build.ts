// Bundles the Mantine widget runtime (src/runtime/index.tsx with React, Mantine, @mantine/charts,
// @mantine/hooks, Sucrase, the design systems' themes and the `relay` kit's components from
// apps/desktop) and its CSS (Mantine core + charts styles, theme-components.css) into
// generated/bundle.ts as two strings, so the phone and desktop ship it offline with no asset fetch;
// writes the names a widget sees (generated/scope.ts) for the host's prototype check; and writes
// the `relay` system's page CSS from Relay Desktop's own stylesheets (generated/relay/styles.ts).
// Run after changing the runtime, the theme CSS, the eCard snapshot, the kit's app components or
// their CSS, or a dependency: `pnpm -C packages/widget-runtime build`.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { widgetScope } from "./src/runtime/scope";
import { systemScope } from "./src/runtime/systems";
import { DESIGN_SYSTEMS } from "./src/systems";
import { RELAY_SYSTEM_CONFIG } from "./src/systems/relay";
import { cssVariablesFor } from "./src/theme";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
function version(name: string): string {
  // Read in place: tsconfig.json's paths point `react/*` at @types/react, for require too.
  const pkg: unknown = JSON.parse(
    readFileSync(join(here, "node_modules", name, "package.json"), "utf8"),
  );
  if (
    typeof pkg === "object" &&
    pkg !== null &&
    "version" in pkg &&
    typeof pkg.version === "string"
  )
    return pkg.version;
  throw new Error(`${name} has no version`);
}

// ---- The `relay` system's page CSS, from Relay Desktop's renderer stylesheets ----

const renderer = join(here, "..", "..", "apps", "desktop", "src", "renderer");

interface CssRule {
  /** The selector list or at-rule prelude, trimmed. */
  prelude: string;
  text: string;
}

/** A stylesheet's top-level rules and at-rules (an @media block whole), comments dropped. */
function cssRules(css: string): CssRule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: CssRule[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) {
      const text = src.slice(start, i + 1).trim();
      rules.push({ prelude: text.slice(0, text.indexOf("{")).trim(), text });
      start = i + 1;
    }
  }
  return rules;
}

const rendererCss = (path: string): CssRule[] =>
  cssRules(readFileSync(join(renderer, path), "utf8")).filter((r) => !r.text.includes("url("));

/** tokens.css: its `:root` token blocks and the two type helpers; not its fonts or app shell. */
const tokenRules = rendererCss("styles/tokens.css").filter((r) =>
  [":root", ".eva-label", ".eva-dim"].includes(r.prelude),
);
const MENU = /\.eva-(sb-)?menu/;
/** The kit components' stylesheets: whole files, and the menu rules of the overlay and sidebar's. */
const kitRules = [
  ...rendererCss("ui/list/list.css"),
  ...rendererCss("chat/strips/strips.css"),
  ...rendererCss("overlay/overlay.css").filter((r) => MENU.test(r.prelude)),
  ...rendererCss("sidebar/customize.css").filter((r) => MENU.test(r.prelude)),
  ...rendererCss("assistants/assistants.css"),
  ...rendererCss("assistants/assistants-grid.css"),
  ...rendererCss("assistants/portrait-motion.css"),
];

/**
 * Every `--eva-*` the tokens and kit CSS read with no fallback must resolve at the page root: from
 * tokens.css's `:root` blocks or the theme's resolver (`--eva-color-*`, theme.ts). One the app
 * defines only on a scoped selector (`.eva-list` sets `--eva-list-bg`, which rows read; a menu
 * portaled out of `.eva-shell` loses `--eva-gap`) is hoisted to `:root` with its app value, so
 * a kit component drawn on its own still resolves it. `--eva-list-grid` is set inline by the
 * columns ListView, never in CSS.
 */
const INLINE_VAR = "--eva-list-grid";
const declared = (rules: readonly CssRule[]): Map<string, string> => {
  const out = new Map<string, string>();
  for (const r of rules)
    for (const m of r.text.matchAll(/(--eva-[\w-]+)\s*:\s*([^;}]+)/g))
      if (m[1] !== undefined && m[2] !== undefined && !out.has(m[1])) out.set(m[1], m[2].trim());
  return out;
};
const resolverVars = cssVariablesFor(RELAY_SYSTEM_CONFIG);
const atRoot = new Set([
  ...declared(tokenRules.filter((r) => r.prelude === ":root")).keys(),
  ...Object.keys(resolverVars.variables),
  ...Object.keys(resolverVars.light),
  ...Object.keys(resolverVars.dark),
]);
const kitDeclared = declared(kitRules);
const hoisted: string[] = [];
for (const r of [...tokenRules, ...kitRules])
  for (const m of r.text.matchAll(/var\(\s*(--eva-[\w-]+)\s*([,)])/g)) {
    const name = m[1];
    if (name === undefined || m[2] === "," || atRoot.has(name) || name === INLINE_VAR) continue;
    const value = kitDeclared.get(name);
    if (value === undefined)
      throw new Error(`relay kit CSS reads ${name}, which no :root or kit rule defines`);
    atRoot.add(name);
    hoisted.push(`  ${name}: ${value};`);
  }
const tokensCss = [
  ...tokenRules.map((r) => r.text),
  ...(hoisted.length > 0
    ? [
        `/* Defined in the app on a scoped selector only; at the root here. */\n:root {\n${hoisted.join("\n")}\n}`,
      ]
    : []),
].join("\n");
const kitCss = kitRules.map((r) => r.text).join("\n");
mkdirSync(join(here, "generated", "relay"), { recursive: true });
const relayOut = join(here, "generated", "relay", "styles.ts");
writeFileSync(
  relayOut,
  `// Generated by build.ts from apps/desktop/src/renderer: styles/tokens.css (its :root blocks,\n` +
    `// .eva-label and .eva-dim), ui/list/list.css, chat/strips/strips.css, the menu rules of\n` +
    `// overlay/overlay.css and sidebar/customize.css, assistants/assistants.css,\n` +
    `// assistants/assistants-grid.css and assistants/portrait-motion.css. Do not edit.\n` +
    `/** Relay Desktop's design tokens, at the page root. */\n` +
    `export const RELAY_TOKENS_CSS = ${JSON.stringify(tokensCss)};\n` +
    `/** The CSS of the kit's components (runtime/relay-kit.tsx). */\n` +
    `export const RELAY_KIT_CSS = ${JSON.stringify(kitCss)};\n`,
);
console.log(
  `wrote ${relayOut}: tokens ${tokensCss.length} bytes, kit ${kitCss.length} bytes, hoisted to :root: ${hoisted.map((h) => h.trim().split(":")[0]).join(", ") || "none"}`,
);

// ---- The runtime bundle ----

/**
 * The kit's components live in apps/desktop, whose own React and Mantine would otherwise resolve
 * from its node_modules: every import of React, ReactDOM and Mantine core and hooks, from any file,
 * takes this package's copy, so the page runs one of each.
 */
const SHARED = /^(react|react-dom|@mantine\/core|@mantine\/hooks)(\/.*)?$/;
const oneCopy: Bun.BunPlugin = {
  name: "one-react-and-mantine",
  setup(build) {
    build.onResolve({ filter: SHARED }, (args) => {
      const path = Bun.resolveSync(args.path, here);
      if (!path.startsWith(join(here, "node_modules")) || /\.d\.m?ts$/.test(path))
        throw new Error(`${args.path} resolved to ${path}, not this package's copy`);
      return { path };
    });
    // The kit's modules are presentational only; their CSS is in generated/relay/styles.ts.
    build.onResolve({ filter: /\.css$/ }, (args) => {
      throw new Error(`${args.importer} imports ${args.path}: the runtime bundles no CSS`);
    });
  },
};

const result = await Bun.build({
  entrypoints: [join(here, "src", "runtime", "index.tsx")],
  target: "browser",
  format: "iife",
  minify: true,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  plugins: [oneCopy],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const [bundle] = result.outputs;
if (bundle === undefined) throw new Error("Bun.build produced no output");
// Inlined in <script>/<style> elements: nothing may close them early.
const js = (await bundle.text()).replaceAll("</script", "<\\/script");
const css = [
  require.resolve("@mantine/core/styles.css"),
  require.resolve("@mantine/charts/styles.css"),
  join(here, "src", "theme-components.css"),
]
  .map((path) => readFileSync(path, "utf8"))
  .join("\n")
  .replaceAll("</style", "<\\/style");

const versions = ["react", "@mantine/core", "@mantine/charts", "recharts", "sucrase"]
  .map((name) => `${name} ${version(name)}`)
  .join(", ");
const out = join(here, "generated", "bundle.ts");
writeFileSync(
  out,
  `// Generated by build.ts from src/runtime and ${versions} (all MIT). Do not edit.\n` +
    `export const WIDGET_RUNTIME_JS = ${JSON.stringify(js)};\n` +
    `export const WIDGET_RUNTIME_CSS = ${JSON.stringify(css)};\n`,
);
console.log(`wrote ${out}: js ${js.length} bytes, css ${css.length} bytes (${versions})`);

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const names = (scope: Record<string, unknown>): string[] =>
  Object.keys(scope)
    .filter((n) => IDENTIFIER.test(n))
    .sort();
const scopeOut = join(here, "generated", "scope.ts");
writeFileSync(
  scopeOut,
  `// Generated by build.ts from src/runtime/scope.ts. Do not edit.\n` +
    `/** Every name a widget's code sees without a design system. */\n` +
    `export const WIDGET_SCOPE_NAMES: readonly string[] = ${JSON.stringify(names(widgetScope()))};\n` +
    `/** The names each design system adds. */\n` +
    `export const SYSTEM_SCOPE_NAMES: Record<"${DESIGN_SYSTEMS.join('" | "')}", readonly string[]> = ${JSON.stringify(Object.fromEntries(DESIGN_SYSTEMS.map((s) => [s, names(systemScope(s))])))};\n`,
);
console.log(`wrote ${scopeOut}`);

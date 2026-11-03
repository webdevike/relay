#!/usr/bin/env bun
// Refreshes the eCard design-system snapshot that canvas `proto` nodes with `system: ecard` draw
// with (packages/widget-runtime/generated/ecard/). Read-only on the eCard repo: files come out of a
// git ref with `git archive`, nothing there is written or committed.
//
//   bun scripts/sync-ecard-design.ts [--repo <path>] [--ref <git ref>] [--fetch]
//
// Defaults: --repo /Users/ike/Eva/work/react-client-reports-app, --ref origin/main. --fetch runs
// `git fetch origin` first (the only thing that touches the eCard repo, and only its remote refs).
//
// What it takes, all from eCard's design-system layer (src/design-system, `@design-system`):
// - theme/theme.ts, tokens.ts, cssTokens.ts, variantColorResolver.ts: bundled with stubs for the
//   private @ecardsystems/js-core helpers and CSS modules, then evaluated, so the snapshot holds the
//   real values: palettes, fonts, radius and font-size scales, the CSS variables resolver output, the
//   Button vars for every variant (read by calling eCard's own `vars` function), the variant mapping.
// - components/Base*.tsx: the pure Mantine facades (`export { X as BaseX } from "@mantine/core"`)
//   become an alias table; components that import only Mantine, React and their CSS modules are
//   copied verbatim (role components, eCard-labelled inputs). Anything that needs icons, app code or
//   other packages is skipped and listed.
// - CSS: src/assets/styles/index.css (body, scrollbars) and the CSS modules the theme and copied
//   components use, class names prefixed `ecard-<Module>-`.
// - Font: Inter, the Google Fonts stylesheet index.html links (latin, variable 400-700), as a data: URL,
//   because the proto frame has no network.
// No business code, data, env files or secrets are read.
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '..', 'packages', 'widget-runtime', 'generated', 'ecard')

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(name)
  return at >= 0 ? (process.argv[at + 1] ?? fallback) : fallback
}
const repo = arg('--repo', '/Users/ike/Eva/work/react-client-reports-app')
const ref = arg('--ref', 'origin/main')
const git = (...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()

if (process.argv.includes('--fetch')) git('fetch', 'origin', '--quiet')
const commit = git('rev-parse', ref)
const committedAt = git('log', '-1', '--format=%cI', commit)
const remote = git('remote', 'get-url', 'origin')
  .replace(/^https:\/\/github\.com\//, '')
  .replace(/\.git$/, '')

// ---------------------------------------------------------------------------------------------

/** `.foo` -> `.ecard-<Module>-foo` outside `:global(...)` (unwrapped); comments dropped. Returns the CSS and the class map. */
function scopeCss(css: string, module: string): { css: string; classes: Record<string, string> } {
  const globals: string[] = []
  let text = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(
      /:global\(([^)]*)\)/g,
      (_m, inner: string) => `@@global${String(globals.push(inner) - 1)}@@`,
    )
  const classes: Record<string, string> = {}
  text = text.replace(/\.(-?[_a-zA-Z][\w-]*)/g, (_m, name: string) => {
    const scoped = `ecard-${module}-${name}`
    classes[name] = scoped
    return `.${scoped}`
  })
  text = text.replace(/@@global(\d+)@@/g, (_m, i: string) => globals[Number(i)] ?? '')
  return { css: text.replace(/\n{3,}/g, '\n\n').trim(), classes }
}

const moduleName = (file: string): string => basename(file).replace(/\.module\.css$/, '')
/** A file of the extracted tree as its path in the eCard repo (the temp dir may show as /var or /private/var). */
const repoPath = (file: string): string => file.slice(file.lastIndexOf('/src/') + 1)

async function sync(root: string): Promise<void> {
  const ds = join(root, 'src', 'design-system')
  const cssModules = new Map<string, { css: string; classes: Record<string, string> }>()
  const scoped = (file: string) => {
    let entry = cssModules.get(file)
    if (!entry) {
      entry = scopeCss(readFileSync(file, 'utf8'), moduleName(file))
      cssModules.set(file, entry)
    }
    return entry
  }

  // 1. The theme modules, bundled with stubs for what is private or styling-only, then run in a
  // child bun that calls eCard's own functions (Button vars per variant, the variant resolver, the
  // CSS variables resolver) and prints the values.
  const entry = join(root, 'theme-entry.ts')
  writeFileSync(
    entry,
    `import { baseTheme } from "./src/design-system/theme/theme";
import { cssVariablesResolver } from "./src/design-system/theme/cssTokens";
import { variantColorResolver } from "./src/design-system/theme/variantColorResolver";
const button = baseTheme.components.Button;
const VARIANTS = ["(none)", "filled", "light", "outline", "subtle", "default", "transparent", "white", "gradient", "contained", "outlined", "text", "quiet", "(other)"];
const buttonVars = (primary) => Object.fromEntries(VARIANTS.map((v) => [v, button.vars({}, { variant: v === "(none)" ? undefined : v === "(other)" ? "__unknown__" : v, color: primary ? undefined : "gray" }).root]));
const map = {};
const custom = {};
for (const v of ["contained", "outlined", "text", "quiet", "filled", "light"]) {
  const out = variantColorResolver({ variant: v, color: "primary", theme: {} });
  if ("__mantineVariant" in out) { if (out.__mantineVariant !== v) map[v] = out.__mantineVariant; } else custom[v] = out;
}
const scrollArea = baseTheme.components.ScrollArea;
console.log(JSON.stringify({
  theme: {
    colors: baseTheme.colors, primaryColor: baseTheme.primaryColor, fontFamily: baseTheme.fontFamily,
    fontFamilyMonospace: baseTheme.fontFamilyMonospace, headingsFontFamily: baseTheme.headings.fontFamily,
    radius: baseTheme.radius, fontSizes: baseTheme.fontSizes,
  },
  cssVariables: cssVariablesResolver(),
  button: { vars: { primary: buttonVars(true), other: buttonVars(false) }, rootStyles: button.styles?.root ?? {}, classNames: button.classNames ?? {} },
  scrollArea: { vars: scrollArea.vars?.().root ?? {}, classNames: scrollArea.classNames ?? {} },
  inputDefaultRadius: String(baseTheme.components.Input?.defaultProps?.radius ?? "sm"),
  variants: { map, custom },
}));
`,
  )
  const built = await Bun.build({
    entrypoints: [entry],
    target: 'bun',
    format: 'esm',
    plugins: [
      {
        name: 'ecard-stubs',
        setup(build) {
          const lib = (p: string): string =>
            join(root, 'src', 'libraries', p.slice('@libraries/'.length))
          build.onResolve({ filter: /\.module\.css$/ }, (a) => ({
            path: a.path.startsWith('@libraries/') ? lib(a.path) : join(a.resolveDir, a.path),
            namespace: 'css-module',
          }))
          build.onResolve({ filter: /^@libraries\// }, (a) => ({ path: `${lib(a.path)}.ts` }))
          build.onResolve({ filter: /^@mantine\/core$/ }, () => ({
            path: 'mantine-core',
            namespace: 'stub',
          }))
          build.onResolve({ filter: /^@ecardsystems\/js-core\// }, (a) => ({
            path: a.path,
            namespace: 'stub',
          }))
          build.onLoad({ filter: /.*/, namespace: 'css-module' }, (a) => ({
            contents: `export default ${JSON.stringify(scoped(a.path).classes)};`,
            loader: 'js',
          }))
          build.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => {
            if (a.path === 'mantine-core')
              return {
                contents:
                  'export const defaultVariantColorsResolver = (input) => ({ __mantineVariant: input.variant });',
                loader: 'js',
              }
            // @ecardsystems/js-core is private and not installed: the two helpers these modules call.
            if (a.path.endsWith('parsing.helper'))
              return {
                contents:
                  "export default { parseString: (v, d) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : d) };",
                loader: 'js',
              }
            if (a.path.endsWith('constants.helper'))
              return {
                contents:
                  'export default { getValueForKey: () => undefined, isValueValid: (o, v) => Object.values(o).includes(v), getSelectOptionForConstant: () => undefined };',
                loader: 'js',
              }
            throw new Error(`no stub for ${a.path}`)
          })
        },
      },
    ],
  })
  if (!built.success) {
    for (const log of built.logs) console.error(log)
    throw new Error('could not bundle the eCard theme modules')
  }
  const bundleFile = join(root, 'theme-bundle.mjs')
  writeFileSync(bundleFile, await built.outputs[0]!.text())
  const extracted = JSON.parse(
    execFileSync(process.execPath, [bundleFile], { encoding: 'utf8' }),
  ) as Record<string, unknown>

  // 2. Components: pure facades, and the ones that need nothing outside Mantine, React and CSS.
  const componentsDir = join(ds, 'components')
  const facades: Record<string, string> = {}
  const skipped: Record<string, string> = {}
  const candidates = new Map<string, string>()
  for (const file of readdirSync(componentsDir).filter(
    (f) => f.endsWith('.tsx') && !f.includes('.test.'),
  )) {
    const text = readFileSync(join(componentsDir, file), 'utf8')
    const values = [...text.matchAll(/^export \{ (\w+) as (Base\w+) \} from "@mantine\/core";$/gm)]
    const rest = text
      .replace(/^export (type )?\{[^}]*\} from "[^"]+";$/gm, '')
      .replace(/^\/\/.*$/gm, '')
      .trim()
    if (values.length > 0 && rest === '') {
      for (const m of values) facades[m[2]!] = m[1]!
      continue
    }
    candidates.set(file.replace(/\.tsx$/, ''), text)
  }
  const ALLOWED = new Set(['@mantine/core', '@mantine/hooks', 'react'])
  const importsOf = (text: string): string[] =>
    [...text.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)";/gm)].map((m) => m[1]!)
  const kept = new Set(candidates.keys())
  for (let changed = true; changed;) {
    changed = false
    for (const name of kept) {
      const bad = importsOf(candidates.get(name)!).find(
        (s) =>
          !ALLOWED.has(s) &&
          !s.endsWith('.module.css') &&
          !(s.startsWith('./') && kept.has(s.slice(2))),
      )
      if (bad !== undefined) {
        kept.delete(name)
        skipped[`components/${name}.tsx`] = `imports ${bad}`
        changed = true
      }
    }
  }
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(join(OUT, 'components'), { recursive: true })
  const exported: { name: string; file: string }[] = []
  for (const name of [...kept].sort()) {
    let text = candidates.get(name)!
    text = text.replace(
      /^import (\w+) from "\.\/([\w.]+\.module\.css)";$/gm,
      (_m, id: string, css: string) =>
        `const ${id}: Record<string, string> = ${JSON.stringify(scoped(join(componentsDir, css)).classes)};`,
    )
    for (const m of text.matchAll(/^export (?:function|const) (Base\w+)/gm))
      exported.push({ name: m[1]!, file: name })
    writeFileSync(
      join(OUT, 'components', `${name}.tsx`),
      `// @ts-nocheck: copied verbatim from ${remote}@${commit.slice(0, 8)} src/design-system/components/${name}.tsx by scripts/sync-ecard-design.ts (CSS module import inlined as its class map); type-checked in its own repo.\n${text}`,
    )
  }
  writeFileSync(
    join(OUT, 'components', 'index.ts'),
    `// Generated by scripts/sync-ecard-design.ts. Do not edit.\n${[
      ...new Set(exported.map((e) => e.file)),
    ]
      .map(
        (f) =>
          `import { ${exported
            .filter((e) => e.file === f)
            .map((e) => e.name)
            .join(', ')} } from "./${f}";`,
      )
      .join(
        '\n',
      )}\n\n/** eCard design-system components copied from ${remote}@${commit.slice(0, 8)}, by name. */\nexport const ECARD_COMPONENTS: Record<string, unknown> = { ${exported.map((e) => e.name).join(', ')} };\n`,
  )

  // 3. Global CSS: index.css plus every CSS module the theme and copied components use.
  const indexCss = readFileSync(join(root, 'src', 'assets', 'styles', 'index.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const moduleCss = [...cssModules.entries()]
    .map(([file, e]) => `/* ${repoPath(file)} */\n${e.css}`)
    .join('\n\n')

  // 4. The font index.html links, as a data: URL.
  const html = readFileSync(join(root, 'index.html'), 'utf8')
  const fontHref = /href="(https:\/\/fonts\.googleapis\.com\/css2\?[^"]+)"/
    .exec(html)?.[1]
    ?.replaceAll('&amp;', '&')
  if (fontHref === undefined) throw new Error('index.html links no Google Fonts stylesheet')
  const fontCss = await (
    await fetch(fontHref, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36',
      },
    })
  ).text()
  const latin = [...fontCss.matchAll(/\/\* latin \*\/\s*@font-face\s*\{([^}]*)\}/g)].map(
    (m) => m[1]!,
  )
  const family = /font-family:\s*'([^']+)'/.exec(latin[0] ?? '')?.[1]
  const urls = [
    ...new Set(
      latin.map((b) => /url\(([^)]+)\)/.exec(b)?.[1]).filter((u): u is string => u !== undefined),
    ),
  ]
  const weights = latin
    .map((b) => Number(/font-weight:\s*(\d+)/.exec(b)?.[1]))
    .filter(Number.isFinite)
  if (family === undefined || urls.length !== 1 || weights.length === 0)
    throw new Error(`expected one variable latin font file in ${fontHref}`)
  const woff2 = Buffer.from(await (await fetch(urls[0]!)).arrayBuffer())
  const range = /unicode-range:\s*([^;]+);/.exec(latin[0]!)?.[1] ?? ''
  const fontFace = `@font-face { font-family: '${family}'; font-style: normal; font-weight: ${String(Math.min(...weights))} ${String(Math.max(...weights))}; font-display: block; src: url(data:font/woff2;base64,${woff2.toString('base64')}) format('woff2'); unicode-range: ${range}; }`

  const files = [
    'src/design-system/theme/theme.ts',
    'src/design-system/theme/tokens.ts',
    'src/design-system/theme/cssTokens.ts',
    'src/design-system/theme/variantColorResolver.ts',
    'src/libraries/react_implementations/ui/buttons/buttonTheme.constants.ts',
    'src/design-system/components/Base*.tsx',
    'src/assets/styles/index.css',
    ...[...cssModules.keys()].map(repoPath),
    `index.html (font: ${fontHref})`,
  ]
  const sorted = (o: Record<string, string>) =>
    Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
  const design = {
    source: { repo: remote, ref, commit, committedAt, files, skipped: sorted(skipped) },
    ...extracted,
    facades: sorted(facades),
  }
  const header = `// Generated by scripts/sync-ecard-design.ts from ${remote}@${commit} (${committedAt}, ${ref}). Do not edit; rerun the script.`
  writeFileSync(
    join(OUT, 'design.ts'),
    `${header}\nimport type { EcardDesign } from "../../src/systems/ecard";\n\nexport const ECARD_DESIGN: EcardDesign = ${JSON.stringify(design, null, 2)};\n`,
  )
  writeFileSync(
    join(OUT, 'styles.ts'),
    `${header}\n/** eCard's global stylesheet and the CSS modules its theme and copied components use (classes prefixed ecard-<Module>-). */\nexport const ECARD_CSS = ${JSON.stringify(`${indexCss}\n\n${moduleCss}\n`)};\n`,
  )
  writeFileSync(
    join(OUT, 'font.ts'),
    `${header}\n/** ${family} (latin, ${urls[0]}), the font eCard's index.html links, inlined: the proto frame has no network. SIL OFL 1.1. */\nexport const ECARD_FONT_CSS = ${JSON.stringify(fontFace)};\n`,
  )
  console.log(
    `eCard design ${remote}@${commit.slice(0, 8)}: ${String(Object.keys(facades).length)} facades, ${String(exported.length)} components (${[...kept].join(', ')}), skipped ${String(Object.keys(skipped).length)}, font ${String(woff2.length)} bytes -> ${OUT}`,
  )
  if (!existsSync(join(OUT, 'design.ts'))) throw new Error('nothing written')
}
const PATHS = [
  'src/design-system',
  'src/libraries/react_implementations/ui/buttons',
  'src/assets/styles/index.css',
  'index.html',
]
const tmp = mkdtempSync(join(tmpdir(), 'ecard-design-'))
try {
  execFileSync('sh', [
    '-c',
    `git -C "$0" archive "$1" ${PATHS.map((p) => `"${p}"`).join(' ')} | tar -x -C "$2"`,
    repo,
    commit,
    tmp,
  ])
  await sync(tmp)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

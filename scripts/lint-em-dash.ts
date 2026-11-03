import * as fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

const DASH = /—/

export interface DashHit {
  line: number
  text: string
}

/** Finds U+2014 inside string literals, template text and JSX text. Comments are ignored. */
export function findEmDashes(file: string, text: string): DashHit[] {
  const sf = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const hits: DashHit[] = []
  const visit = (n: ts.Node): void => {
    const isText =
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n) ||
      ts.isJsxText(n)
    if (isText && DASH.test(n.getText(sf))) {
      hits.push({
        line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
        text: n.getText(sf).trim().slice(0, 80),
      })
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return hits
}

function main(): void {
  const files = [
    ...fs.globSync('apps/desktop/src/renderer/**/*.{ts,tsx}'),
    ...fs.globSync(
      'packages/{browser-core,chat-core,contract,eva-core,shell-core}/src/**/*.{ts,tsx}',
    ),
  ]
    // Vendored openui lang-core: its strings are LLM prompt text and parser errors, never UI.
    .filter((f) => !f.includes('node_modules') && !f.includes('/openui/lang/'))
  let bad = 0
  for (const f of files) {
    for (const h of findEmDashes(f, fs.readFileSync(f, 'utf8'))) {
      console.error(`${f}:${h.line}: ${h.text}`)
      bad++
    }
  }
  if (bad > 0) {
    console.error(`em-dash lint: ${bad} hit(s)`)
    process.exit(1)
  }
  console.log(`em-dash lint: ${files.length} files clean`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()

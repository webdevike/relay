import type {
  AgentNote,
  BrowserNoteTarget,
  DesignItem,
  DesignStyleEdit,
  InvokeParsed,
} from '@evaos/contract'

type DesignSend = Omit<InvokeParsed<'design.send'>, 'tabId'>

/** One selected element as a page note's target, its screenshot saved by `save` (a PNG path). */
async function targetOf(
  item: DesignItem,
  edits: DesignStyleEdit[],
  drawn: string | undefined,
  save: (pngBase64: string) => Promise<string>,
): Promise<BrowserNoteTarget> {
  const png = drawn ?? item.crop?.png
  const style: NonNullable<BrowserNoteTarget['style']> = {}
  for (const e of edits)
    if (e.selector === item.selector) style[e.property] = { from: e.from, to: e.to }
  const s = item.source
  return {
    element: {
      // The label starts with the tag (`button.primary`).
      tag: /^[a-z][a-z0-9-]*/i.exec(item.label)?.[0] ?? 'element',
      ...(item.text ? { text: item.text } : {}),
      selector: item.selector,
    },
    region: { x: item.box.x, y: item.box.y, w: item.box.width, h: item.box.height },
    ...(png ? { image: await save(png) } : {}),
    ...(drawn ? { drawn: true } : {}),
    ...(s
      ? {
          source: {
            file: s.file,
            line: s.line,
            column: s.column,
            ...(s.via === 'react-stack' ? { approximate: true } : {}),
          },
        }
      : {}),
    ...(item.component ? { component: item.component } : {}),
    html: item.html,
    computed: { ...item.styles },
    ...(Object.keys(style).length > 0 ? { style } : {}),
  }
}

/**
 * A Design Mode Send as a page note of intent `change` (agent-presence/notes.ts sends it): the
 * present elements in selection order (the first is the note's own target, the rest `also`),
 * Isaac's words, and each element's screenshot saved through `save`. Null when no selected element
 * is in the page. With no words, the text points at his edits or drawing so the note says something.
 */
export async function designNote(
  req: DesignSend,
  page: { tabId: string; url: string; title: string },
  save: (pngBase64: string) => Promise<string>,
): Promise<AgentNote | null> {
  const targets: BrowserNoteTarget[] = []
  for (const item of req.items) {
    if (item.missing) continue
    targets.push(await targetOf(item, req.edits, req.drawings[item.selector], save))
  }
  const [first, ...also] = targets
  if (!first) return null
  const words =
    req.instruction.trim() ||
    (targets.some((t) => t.style)
      ? 'Apply my style edits.'
      : 'Change what I drew on the screenshot.')
  return {
    surface: 'browser',
    intent: 'change',
    text: words.slice(0, 4000),
    url: page.url.slice(0, 4000),
    title: page.title.slice(0, 500),
    tabId: page.tabId,
    ...first,
    ...(also.length > 0 ? { also } : {}),
  }
}

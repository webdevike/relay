/**
 * Draws an XState v5 machine as a Mermaid `stateDiagram-v2`, straight from its definition, so the
 * pictures in `docs/state-machines/` can never drift from the code (`machine-docs.test.ts` fails
 * when one is stale; `pnpm machines:docs` rewrites them). Pure: reads only the machine's state
 * nodes. The desktop's copy of apps/mobile/src/lib/machineDiagram.ts (two installs, no shared
 * package between them): change both together.
 *
 * What is drawn: every state (nested states as composite states, parallel regions split by `--`),
 * each initial state, and every transition that changes state, labelled with its event and, in
 * brackets, its guard. Transitions that only update data (no target) are left out so the picture
 * shows the shape, not the bookkeeping.
 */
import type { AnyStateMachine } from 'xstate'

/** The parts of an XState state node this reads (its public, documented fields). */
interface Node {
  id: string
  key: string
  type: 'atomic' | 'compound' | 'parallel' | 'final' | 'history'
  initial?: { target: readonly Node[] }
  states: Record<string, Node>
  transitions: Map<string, readonly Transition[]>
  always?: readonly Transition[]
  invoke: readonly { id: string; src: unknown }[]
}

interface Transition {
  eventType: string
  target?: readonly Node[]
  guard?: unknown
  reenter?: boolean
}

/** Mermaid ids may not contain dots; the machine id prefix is dropped to keep them short. */
function idOf(node: Node, root: Node): string {
  if (node === root) return 'root'
  return node.id.slice(root.id.length + 1).replace(/[^A-Za-z0-9_]/g, '_')
}

/** A guard's name: its `type` for named and built-in guards, `guard` for an inline function. */
function guardName(guard: unknown): string {
  if (guard === undefined) return ''
  if (typeof guard === 'string') return guard
  if (typeof guard === 'function')
    return guard.name === '' || guard.name === 'guard' ? 'guard' : guard.name
  if (
    typeof guard === 'object' &&
    guard !== null &&
    'type' in guard &&
    typeof guard.type === 'string'
  ) {
    const params = 'params' in guard ? guard.params : undefined
    const op = /^xstate\.(and|or|not)$/.exec(guard.type)?.[1]
    if (
      op !== undefined &&
      typeof params === 'object' &&
      params !== null &&
      'guards' in params &&
      Array.isArray(params.guards)
    ) {
      return `${op}(${params.guards.map(guardName).join(', ')})`
    }
    return guard.type
  }
  return 'guard'
}

/** Plain words for XState's internal event names. */
function eventLabel(eventType: string, node: Node): string {
  if (eventType === '') return 'always'
  const after = /^xstate\.after\.([^.]+)\./.exec(eventType)
  if (after !== null) return `after ${after[1]}`
  // An invoked actor's done or error event names it by id; an unnamed invoke has a generated id, so show its source.
  const settled = /^xstate\.(done|error)\.actor\.(.+)$/.exec(eventType)
  if (settled !== null) {
    const src = node.invoke.find((entry) => entry.id === settled[2])?.src
    return `${settled[1]} ${typeof src === 'string' ? src : settled[2]}`
  }
  if (eventType.startsWith('xstate.done.state.')) return 'done'
  return eventType
}

function label(transition: Transition, node: Node): string {
  const guard = guardName(transition.guard)
  // Mermaid ends a label at a colon or semicolon; brackets and the rest are fine.
  const text = eventLabel(transition.eventType, node).replace(/[:;]/g, ' ')
  return guard === '' ? text : `${text} [${guard.replace(/[:;]/g, ' ')}]`
}

function drawNode(node: Node, root: Node, indent: string, lines: string[]): void {
  const children = Object.values(node.states)
  // Mermaid only splits regions (`--`) inside a composite state, so a parallel machine is drawn as one box.
  const boxed = node !== root || node.type === 'parallel'
  if (boxed) {
    const id = idOf(node, root)
    const name = node === root ? `${node.key} (all regions)` : node.key
    if (name !== id) lines.push(`${indent}state "${name}" as ${id}`)
    if (children.length === 0) return
    lines.push(`${indent}state ${id} {`)
  }
  const inner = boxed ? `${indent}  ` : indent
  if (node.type === 'parallel') {
    children.forEach((child, index) => {
      if (index > 0) lines.push(`${inner}--`)
      drawNode(child, root, inner, lines)
    })
  } else {
    const initial = node.initial?.target[0]
    if (initial !== undefined) lines.push(`${inner}[*] --> ${idOf(initial, root)}`)
    for (const child of children) drawNode(child, root, inner, lines)
  }
  if (boxed) lines.push(`${indent}}`)
}

function drawTransitions(node: Node, root: Node, lines: string[]): void {
  const all = [...node.transitions.values()].flat().concat(node.always ?? [])
  for (const transition of all) {
    for (const target of transition.target ?? []) {
      lines.push(
        `  ${node === root ? 'anyState' : idOf(node, root)} --> ${idOf(target, root)} : ${label(transition, node)}`,
      )
    }
  }
  for (const child of Object.values(node.states)) drawTransitions(child, root, lines)
  if (node.type === 'final') lines.push(`  ${idOf(node, root)} --> [*]`)
}

/** The machine as Mermaid source (no fence), stable for the same definition. */
export function machineDiagram(machine: AnyStateMachine): string {
  // XState types its state nodes with generics that do not narrow here; `Node` names the public fields read.
  const root = machine.root as unknown as Node
  const lines = ['stateDiagram-v2']
  // Events handled on the machine itself apply in every state: they leave from a box of their own
  // (Mermaid cannot draw an edge from a composite state into its own child).
  if (root.transitions.size > 0 || (root.always?.length ?? 0) > 0)
    lines.push(`  state "any state" as anyState`)
  drawNode(root, root, '  ', lines)
  drawTransitions(root, root, lines)
  return lines.join('\n')
}

const START =
  '<!-- diagram:start (generated from the machine by `pnpm machines:docs`; do not edit) -->'
const END = '<!-- diagram:end -->'

/** `doc` with its generated block replaced by `diagram`; null when the doc has no markers. */
export function withDiagram(doc: string, diagram: string): string | null {
  const start = doc.indexOf(START)
  const end = doc.indexOf(END)
  if (start === -1 || end < start) return null
  return `${doc.slice(0, start)}${START}\n\`\`\`mermaid\n${diagram}\n\`\`\`\n${doc.slice(end)}`
}

/** A new doc page: title, the plain-English lines to fill in, and the generated block. */
export function newDoc(title: string, diagram: string): string {
  return `# ${title}\n\nTODO: two or three plain sentences on what each state means.\n\n${START}\n\`\`\`mermaid\n${diagram}\n\`\`\`\n${END}\n`
}

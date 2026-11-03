import {
  CANVAS_VERSION,
  CanvasBoardSchema,
  type CanvasBoard,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeData,
} from '@evaos/contract'

export function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

/** Native `board::parse`: JSON, unknown fields dropped, a newer `version` refused. */
export function parseBoard(text: string): CanvasBoard {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw coded(e instanceof Error ? e.message : String(e), 'invalid-data')
  }
  const version = (raw as { version?: unknown } | null)?.version
  if (typeof version === 'number' && version > CANVAS_VERSION) {
    throw coded(
      `version ${version} is newer than this Relay reads (${CANVAS_VERSION})`,
      'invalid-data',
    )
  }
  const parsed = CanvasBoardSchema.safeParse(raw)
  if (!parsed.success) throw coded(parsed.error.message, 'invalid-data')
  return parsed.data
}

/**
 * A number as serde_json writes an `f32`: the shortest decimal that reads back as the same f32,
 * laid out the way ryu's `format32` does (`0.0`, `115.0`, `0.31`, `1e30`, `1.5e-7`).
 */
export function f32Text(value: number): string {
  const f = Math.fround(value)
  if (!Number.isFinite(f)) throw coded(`${value} does not fit a board coordinate`, 'invalid-data')
  if (f === 0) return Object.is(f, -0) ? '-0.0' : '0.0'
  let shortest = f.toPrecision(9)
  for (let p = 1; p < 9; p++) {
    const s = f.toPrecision(p)
    if (Math.fround(Number(s)) === f) {
      shortest = s
      break
    }
  }
  const [mant, exp] = Math.abs(Number(shortest)).toExponential().split('e') as [string, string]
  const digits = mant.replace('.', '')
  const length = digits.length
  const kk = Number(exp) + 1 // 10^(kk-1) <= |v| < 10^kk
  const k = kk - length
  const sign = f < 0 ? '-' : ''
  if (k >= 0 && kk <= 13) return `${sign}${digits}${'0'.repeat(k)}.0`
  if (kk > 0 && kk <= 13) return `${sign}${digits.slice(0, kk)}.${digits.slice(kk)}`
  if (kk > -6 && kk <= 0) return `${sign}0.${'0'.repeat(-kk)}${digits}`
  if (length === 1) return `${sign}${digits}e${kk - 1}`
  return `${sign}${digits[0]}.${digits.slice(1)}e${kk - 1}`
}

/** A JSON value whose numbers are already formatted; objects keep their key order. */
type Json = string | Raw | Obj | Json[]
class Raw {
  constructor(readonly text: string) {}
}
class Obj {
  constructor(readonly fields: Array<[string, Json | undefined]>) {}
}

const f32 = (n: number | undefined): Raw | undefined =>
  n === undefined ? undefined : new Raw(f32Text(n))

/** Native `Data::is_empty`: no field set and no swatches means no `data` key at all. */
function dataObj(d: CanvasNodeData | undefined): Obj | undefined {
  if (!d) return undefined
  const colors =
    d.colors && d.colors.length > 0
      ? d.colors.map(
          (c) =>
            new Obj([
              ['hex', c.hex],
              ['name', c.name],
            ]),
        )
      : undefined
  const obj = new Obj([
    ['title', d.title],
    ['body', d.body],
    ['key', d.key],
    ['status', d.status],
    ['pr', d.pr],
    ['src', d.src],
    ['caption', d.caption],
    ['url', d.url],
    ['tone', d.tone],
    ['colors', colors],
    ['font', d.font],
    ['sample', d.sample],
    ['system', d.system],
    ['viewport', d.viewport],
  ])
  return obj.fields.some(([, v]) => v !== undefined) ? obj : undefined
}

const nodeObj = (n: CanvasNode): Obj =>
  new Obj([
    ['id', n.id],
    ['type', n.type],
    ['x', f32(n.x)],
    ['y', f32(n.y)],
    ['w', f32(n.w)],
    ['h', f32(n.h)],
    ['parent', n.parent],
    ['data', dataObj(n.data)],
  ])

const edgeObj = (e: CanvasEdge): Obj =>
  new Obj([
    ['id', e.id],
    ['source', e.source],
    ['target', e.target],
    ['sourceHandle', e.sourceHandle],
    ['targetHandle', e.targetHandle],
    ['label', e.label],
    ['tone', e.tone],
  ])

/** serde_json's pretty printer: two-space indent, `"key": value`, `[]` / `{}` when empty. */
function write(value: Json, indent: string): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value instanceof Raw) return value.text
  const inner = `${indent}  `
  if (value instanceof Obj) {
    const rows = value.fields.flatMap(([k, v]) =>
      v === undefined ? [] : [`${inner}${JSON.stringify(k)}: ${write(v, inner)}`],
    )
    return rows.length === 0 ? '{}' : `{\n${rows.join(',\n')}\n${indent}}`
  }
  if (value.length === 0) return '[]'
  return `[\n${value.map((v) => `${inner}${write(v, inner)}`).join(',\n')}\n${indent}]`
}

/**
 * Native `board::to_text`: the same board always gives the same text, byte for byte what native
 * EvaOS writes, so an unchanged board never rewrites its file in either app.
 */
export function boardText(board: CanvasBoard): string {
  const vp = board.viewport
  const root = new Obj([
    ['version', new Raw(String(board.version))],
    ['title', board.title],
    ['layout', board.layout],
    ['nodes', board.nodes.map(nodeObj)],
    ['edges', board.edges.map(edgeObj)],
    [
      'viewport',
      vp &&
        new Obj([
          ['x', f32(vp.x)],
          ['y', f32(vp.y)],
          ['zoom', f32(vp.zoom)],
        ]),
    ],
  ])
  return `${write(root, '')}\n`
}

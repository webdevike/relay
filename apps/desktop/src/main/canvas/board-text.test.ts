import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { boardText, parseBoard } from './board-text'

const repo = path.resolve(__dirname, '../../../../..')
const boards = (dir: string): string[] =>
  fs
    .readdirSync(path.join(repo, dir))
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(repo, dir, f))

describe('board text', () => {
  it.each(boards('fixtures/canvases-native'))('re-serializes native %s byte for byte', (file) => {
    const text = fs.readFileSync(file, 'utf8')
    expect(boardText(parseBoard(text))).toBe(text)
  })

  it.each(boards('fixtures/canvases'))('re-serializes fixture %s byte for byte', (file) => {
    const text = fs.readFileSync(file, 'utf8')
    expect(boardText(parseBoard(text))).toBe(text)
  })

  it('refuses a newer version and bad types, and defaults the rest', () => {
    expect(() => parseBoard('{"version": 2, "title": "x"}')).toThrow(/newer/)
    expect(() => parseBoard('{"version": 2}')).toThrow(
      expect.objectContaining({ code: 'invalid-data' }),
    )
    expect(() => parseBoard('{"nodes": [{"id": "a", "type": "blob"}]}')).toThrow(
      expect.objectContaining({ code: 'invalid-data' }),
    )
    expect(() => parseBoard('{')).toThrow(expect.objectContaining({ code: 'invalid-data' }))
    expect(parseBoard('{"title": "x"}')).toEqual({ version: 1, title: 'x', nodes: [], edges: [] })
  })

  it('drops unknown fields, empty data and empty swatches like serde', () => {
    const board = parseBoard(
      JSON.stringify({
        title: 't',
        extra: true,
        nodes: [
          { id: 'a', type: 'note', data: {}, z: 1 },
          { id: 'b', type: 'palette', data: { colors: [] } },
          { id: 'c', type: 'note', x: 1.5, data: { title: '', weird: 1 } },
        ],
        edges: [{ id: 'e', source: 'a', target: 'c', curve: 'x' }],
      }),
    )
    expect(boardText(board)).toBe(
      `{
  "version": 1,
  "title": "t",
  "nodes": [
    {
      "id": "a",
      "type": "note"
    },
    {
      "id": "b",
      "type": "palette"
    },
    {
      "id": "c",
      "type": "note",
      "x": 1.5,
      "data": {
        "title": ""
      }
    }
  ],
  "edges": [
    {
      "id": "e",
      "source": "a",
      "target": "c"
    }
  ]
}
`,
    )
  })
})

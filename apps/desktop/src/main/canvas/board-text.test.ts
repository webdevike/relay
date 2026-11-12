import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CanvasBoard } from '@evaos/contract'
import { boardText, overFile, pageView, parseBoard } from './board-text'

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
    expect(() => parseBoard('{"nodes": [{"id": "a", "type": "two words"}]}')).toThrow(
      expect.objectContaining({ code: 'invalid-data' }),
    )
    expect(() => parseBoard('{')).toThrow(expect.objectContaining({ code: 'invalid-data' }))
    expect(parseBoard('{"title": "x"}')).toEqual({ version: 1, title: 'x', nodes: [], edges: [] })
  })

  it('drops empty data and empty swatches like serde', () => {
    const board = parseBoard(
      JSON.stringify({
        title: 't',
        nodes: [
          { id: 'a', type: 'note', data: {} },
          { id: 'b', type: 'palette', data: { colors: [] } },
          { id: 'c', type: 'note', x: 1.5, data: { title: '' } },
        ],
        edges: [{ id: 'e', source: 'a', target: 'c' }],
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

  it('keeps pins, link routes and the new card fields through a read and a write', () => {
    const text = JSON.stringify({
      version: 1,
      title: 't',
      nodes: [
        {
          id: 'a',
          type: 'step',
          x: 0,
          y: 0,
          data: { title: 'A', icon: 'photo', step: '1', odd: 1 },
        },
        { id: 'b', type: 'note', x: 300, y: 0, pinned: true, later: 'kept' },
      ],
      edges: [
        {
          id: 'a-b',
          source: 'a',
          target: 'b',
          route: [
            { x: 1, y: 2 },
            { x: 3, y: 2 },
          ],
        },
      ],
    })
    const file = parseBoard(text)
    const { board } = pageView(file, undefined)
    expect(board.nodes[0]!.data).toMatchObject({ title: 'A', icon: 'photo', step: '1' })
    expect(board.nodes[1]!.pinned).toBe(true)
    expect(board.edges[0]!.route).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 2 },
    ])
    // Unchanged, it writes the file back as it was.
    expect(JSON.parse(boardText(overFile(board, file)))).toEqual(JSON.parse(text))
    // A save that sets them (the page or an agent), and one that clears a pin.
    const next: CanvasBoard = {
      ...board,
      nodes: [
        { ...board.nodes[0]!, pinned: true, data: { title: 'A', why: 'Because', variant: 'lane' } },
        { id: 'b', type: 'note', x: 300, y: 0 },
      ],
      edges: [
        {
          id: 'a-b',
          source: 'a',
          target: 'b',
          route: [
            { x: 5, y: 6 },
            { x: 7, y: 6 },
          ],
        },
      ],
    }
    const written = JSON.parse(boardText(overFile(next, file)))
    expect(written.nodes).toEqual([
      {
        id: 'a',
        type: 'step',
        x: 0,
        y: 0,
        data: { title: 'A', odd: 1, why: 'Because', variant: 'lane' },
        pinned: true,
      },
      { id: 'b', type: 'note', x: 300, y: 0, later: 'kept' },
    ])
    expect(written.edges[0].route).toEqual([
      { x: 5, y: 6 },
      { x: 7, y: 6 },
    ])
    // A new board (no file yet) keeps them too.
    expect(JSON.parse(boardText(overFile(next, null))).nodes[0].pinned).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import type { DesignItem } from '@evaos/contract'
import { designNote } from './design-send'

const item = (selector: string, over: Partial<DesignItem> = {}): DesignItem => ({
  selector,
  label: `button${selector}`,
  missing: false,
  text: 'Save',
  html: '<button>Save</button>',
  box: { x: 1, y: 2, width: 30, height: 40 },
  source: null,
  component: null,
  styles: { padding: '10px' },
  crop: { png: `crop-${selector}`, width: 30, height: 40 },
  ...over,
})

const page = { tabId: 't1', url: 'http://localhost:5173/', title: 'App' }
const save = async (png: string): Promise<string> => `/notes/${png}.png`

describe('design note', () => {
  it('puts present elements in order, each with its own edits and its drawing over its crop', async () => {
    const note = await designNote(
      {
        instruction: '  quieter ',
        items: [
          item('#gone', { missing: true }),
          item('#a', {
            source: { file: 'src/A.tsx', line: 3, column: 1, via: 'react-stack' },
            component: 'A',
          }),
          item('#b'),
        ],
        edits: [
          { selector: '#b', property: 'padding', from: '10px', to: '4px' },
          { selector: '#gone', property: 'padding', from: '1px', to: '2px' },
        ],
        drawings: { '#b': 'drawn-b' },
      },
      page,
      save,
    )
    expect(note).toMatchObject({
      surface: 'browser',
      intent: 'change',
      text: 'quieter',
      element: { tag: 'button', selector: '#a', text: 'Save' },
      region: { x: 1, y: 2, w: 30, h: 40 },
      image: '/notes/crop-#a.png',
      source: { file: 'src/A.tsx', line: 3, column: 1, approximate: true },
      component: 'A',
      computed: { padding: '10px' },
    })
    expect(note).not.toHaveProperty('style')
    expect(note).not.toHaveProperty('drawn')
    expect(note!.surface === 'browser' && note!.also).toEqual([
      expect.objectContaining({
        element: expect.objectContaining({ selector: '#b' }),
        image: '/notes/drawn-b.png',
        drawn: true,
        style: { padding: { from: '10px', to: '4px' } },
      }),
    ])
  })

  it('says what to look at when Isaac wrote nothing, and makes no note of only missing elements', async () => {
    const edits = [{ selector: '#a', property: 'padding' as const, from: '10px', to: '4px' }]
    const base = { instruction: ' ', items: [item('#a')], drawings: {} }
    expect((await designNote({ ...base, edits }, page, save))?.text).toBe('Apply my style edits.')
    expect(
      (await designNote({ ...base, edits: [], drawings: { '#a': 'x' } }, page, save))?.text,
    ).toBe('Change what I drew on the screenshot.')
    expect(
      await designNote({ ...base, items: [item('#a', { missing: true })], edits }, page, save),
    ).toBeNull()
  })
})

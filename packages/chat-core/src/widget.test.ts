import { describe, expect, it } from 'vitest'
import {
  MAX_CHILDREN,
  MAX_DEPTH,
  parseAppLink,
  parseAssistantAvatar,
  parseWidget,
  type WidgetSpec,
} from './widget'

const parse = (spec: object): WidgetSpec | null => parseWidget(JSON.stringify(spec))

/** One valid spec per node kind, the way showcase.md writes them. */
const EVERY_NODE: Record<WidgetSpec['widget'], object> = {
  chart: {
    widget: 'chart',
    kind: 'bar',
    stacked: true,
    title: 'Calls',
    labels: ['W1', 'W2'],
    series: [{ name: 'a', color: '#A7F3D0', points: [1, 2] }],
  },
  stat: {
    widget: 'stat',
    label: 'Collected',
    value: '$7.9k',
    delta: { value: '12%', direction: 'up' },
  },
  tickets: {
    widget: 'tickets',
    tickets: [
      { id: 'ENG-1', title: 'T', summary: 'S', stateType: 'started', url: 'https://linear.app/x' },
    ],
  },
  compare: {
    widget: 'compare',
    before: { src: '/drops/a/b', label: 'Before' },
    after: { src: 'https://x.com/a.png' },
  },
  audio: { widget: 'audio', title: 'Clip', src: '/drops/a/b' },
  video: { widget: 'video', title: 'Film', src: '/drops/x/y' },
  gallery: {
    widget: 'gallery',
    images: [
      { src: 'https://cdn.example.com/a.png', title: 'A', url: 'https://dribbble.com/shots/1' },
    ],
  },
  model: { widget: 'model', src: '/drops/a/b', autoRotate: true },
  diagram: { widget: 'diagram', src: '/tmp/flow.png', title: 'Flow', caption: 'c' },
  recipe: {
    widget: 'recipe',
    title: 'Tacos',
    meta: ['15 minutes'],
    ingredients: [{ section: 'Tacos', item: 'pork' }],
    directions: ['Sear.'],
    source: 'https://example.com/recipe',
  },
  text: { widget: 'text', text: 'Hi', style: 'heading' },
  rows: { widget: 'rows', rows: [{ label: 'a', value: 'b', tone: 'ok' }] },
  badge: { widget: 'badge', label: 'eCard', tone: 'accent' },
  divider: { widget: 'divider' },
  diff: { widget: 'diff', file: 'a.ts', patch: '@@ -1 +1 @@\n-a\n+b' },
  emails: { widget: 'emails', emails: [{ from: 'Noah', subject: 'Hi', unread: true }] },
  pr: {
    widget: 'pr',
    repo: 'o/r',
    number: 12,
    title: 'Fix',
    state: 'open',
    reviewers: [{ name: 'Noah', state: 'approved' }],
    checks: [{ name: 'lint', status: 'success' }],
    files: [{ file: 'a.ts', patch: '@@ -1 +1 @@\n-a\n+b', additions: 1, deletions: 1 }],
  },
  button: { widget: 'button', label: 'Go', reply: 'go', variant: 'primary' },
  link: { widget: 'link', label: 'PR', url: 'https://github.com' },
  image: { widget: 'image', src: 'https://x.com/a.png', aspect: 1.5 },
  table: {
    widget: 'table',
    columns: ['A', { label: 'B', align: 'right' }],
    rows: [
      ['x', 1],
      [{ text: '#12', url: 'https://github.com/a/b/pull/12', icon: 'github' }, 2],
    ],
  },
  progress: { widget: 'progress', value: 7, max: 9, label: 'Checks', tone: 'ok' },
  list: { widget: 'list', style: 'check', items: ['a', { text: 'b', checked: true }] },
  callout: { widget: 'callout', text: 'Careful', tone: 'warn' },
  code: { widget: 'code', code: 'let a = 1', language: 'ts' },
  quote: { widget: 'quote', text: 'ship it', cite: 'Noah' },
  avatar: { widget: 'avatar', name: 'Noah Kim', subtitle: 'Reviewer' },
  timeline: { widget: 'timeline', items: [{ title: 'Merged', time: '2h', tone: 'ok' }] },
  input: { widget: 'input', placeholder: 'Name', reply: 'rename to {value}' },
  stack: { widget: 'stack', direction: 'horizontal', gap: 'xs', children: [{ widget: 'divider' }] },
  card: { widget: 'card', title: 'C', children: [{ widget: 'divider' }] },
  grid: { widget: 'grid', columns: 3, children: [{ widget: 'divider' }] },
  tabs: {
    widget: 'tabs',
    tabs: [
      { label: 'One', children: [{ widget: 'divider' }] },
      { label: 'Two', children: [{ widget: 'divider' }] },
    ],
  },
  collapse: { widget: 'collapse', title: 'More', children: [{ widget: 'divider' }] },
}

const nest = (depth: number): object =>
  depth === 0 ? { widget: 'divider' } : { widget: 'stack', children: [nest(depth - 1)] }

describe('parseWidget', () => {
  it('accepts every node kind', () => {
    for (const [kind, spec] of Object.entries(EVERY_NODE)) {
      expect(parse(spec)?.widget, kind).toBe(kind)
    }
  })

  it('accepts `type` as an alias for `widget` on every node, and `widget` wins', () => {
    const spec = parse({ type: 'stack', children: [{ type: 'button', label: 'Go', reply: 'go' }] })
    expect(spec).toMatchObject({ widget: 'stack', children: [{ widget: 'button', label: 'Go' }] })
    expect(parse({ widget: 'stat', type: 'sparkle', label: 'L', value: '9' })?.widget).toBe('stat')
    expect(parse({ type: 'sparkle' })).toBeNull()
  })

  it('rejects bad JSON, unknown nodes and a bad node anywhere in the tree', () => {
    expect(parseWidget('{"widget":')).toBeNull()
    expect(parseWidget('[1]')).toBeNull()
    expect(parse({ widget: 'sparkle' })).toBeNull()
    expect(
      parse({ widget: 'card', children: [{ widget: 'divider' }, { widget: 'text' }] }),
    ).toBeNull()
  })

  it('parses relay:// app links and only those', () => {
    expect(parseAppLink('relay://assistant/nova')).toEqual({ kind: 'assistant', id: 'nova' })
    expect(parseAppLink('relay://open/test-bench')).toEqual({ kind: 'open', page: 'test-bench' })
    for (const bad of [
      'relay://assistant/',
      'relay://assistant/Nova',
      'relay://assistant/a/b',
      'relay://assistant/nova?x=1',
      'relay://reviews?item=x',
      'relay://other/nova',
      'javascript:alert(1)',
      'https://example.com',
    ])
      expect(parseAppLink(bad)).toBeNull()
  })

  it('keeps relay://assistant/<id>/avatar as an avatar src and drops other relay:// sources', () => {
    expect(parseAssistantAvatar('relay://assistant/nova/avatar')).toBe('nova')
    expect(parseAssistantAvatar('relay://assistant/nova')).toBeNull()
    expect(
      parse({ widget: 'avatar', name: 'Nova', src: 'relay://assistant/nova/avatar' }),
    ).toMatchObject({
      src: 'relay://assistant/nova/avatar',
    })
    expect(parse({ widget: 'avatar', name: 'Nova', src: 'relay://assistant/nova' })).toEqual({
      widget: 'avatar',
      name: 'Nova',
    })
  })

  it('takes a relay:// url on a card, link and button; a card drops a bad one', () => {
    const kids = [{ widget: 'divider' }]
    expect(
      parse({ widget: 'card', title: 'Nova', url: 'relay://assistant/nova', children: kids }),
    ).toMatchObject({ url: 'relay://assistant/nova' })
    expect(parse({ widget: 'card', url: 'https://example.com/x', children: kids })).toMatchObject({
      url: 'https://example.com/x',
    })
    expect(parse({ widget: 'card', url: 'relay://nope/x', children: kids })).toEqual({
      widget: 'card',
      children: kids,
    })
    expect(parse({ widget: 'link', label: 'Nova', url: 'relay://assistant/nova' })).not.toBeNull()
    expect(parse({ widget: 'link', label: 'Bad', url: 'relay://nope' })).toBeNull()
    expect(parse({ widget: 'button', label: 'Go', url: 'relay://open/jobs' })).not.toBeNull()
    expect(parse({ widget: 'link', label: 'Bad', url: 'javascript:alert(1)' })).toBeNull()
  })

  it('caps container depth and children', () => {
    expect(parse(nest(MAX_DEPTH))).not.toBeNull()
    expect(parse(nest(MAX_DEPTH + 1))).toBeNull()
    const kids = (n: number) => Array.from({ length: n }, () => ({ widget: 'divider' }))
    expect(parse({ widget: 'stack', children: kids(MAX_CHILDREN) })).not.toBeNull()
    expect(parse({ widget: 'stack', children: kids(MAX_CHILDREN + 1) })).toBeNull()
    expect(parse({ widget: 'stack', children: [] })).toBeNull()
  })

  it('counts a tabs node as one container level', () => {
    const tabs = (inner: object) => ({
      widget: 'tabs',
      tabs: [
        { label: 'A', children: [inner] },
        { label: 'B', children: [{ widget: 'divider' }] },
      ],
    })
    expect(parse(tabs(nest(MAX_DEPTH - 1)))).not.toBeNull()
    expect(parse(tabs(nest(MAX_DEPTH)))).toBeNull()
    expect(
      parse({ widget: 'tabs', tabs: [{ label: 'A', children: [{ widget: 'divider' }] }] }),
    ).toBeNull()
  })

  it('needs exactly one of url or reply on a button, and an http(s) url', () => {
    expect(parse({ widget: 'button', label: 'x', url: 'https://a.com', reply: 'y' })).toBeNull()
    expect(parse({ widget: 'button', label: 'x' })).toBeNull()
    expect(parse({ widget: 'button', label: 'x', url: 'javascript:alert(1)' })).toBeNull()
    expect(parse({ widget: 'button', label: ' ', reply: 'y' })).toBeNull()
    expect(
      parse({ widget: 'button', label: 'Open', url: 'https://linear.app', variant: 'weird' }),
    ).toEqual({
      widget: 'button',
      label: 'Open',
      url: 'https://linear.app',
      variant: 'secondary',
    })
  })

  it('needs one table cell per column and http(s) cell links', () => {
    expect(parse({ widget: 'table', columns: ['A', 'B'], rows: [['x']] })).toBeNull()
    expect(
      parse({ widget: 'table', columns: ['A'], rows: [[{ text: 'x', url: 'ftp://x.com' }]] }),
    ).toBeNull()
    expect(
      parse({ widget: 'table', columns: ['A'], rows: [[{ text: '', icon: 'gitlab' }]] }),
    ).toBeNull()
  })

  it('clamps progress and degrades a bad max to 100', () => {
    expect(parse({ widget: 'progress', value: 140, max: -1 })).toMatchObject({
      value: 100,
      max: 100,
      tone: 'accent',
    })
    expect(parse({ widget: 'progress', value: -5 })).toMatchObject({ value: 0 })
  })

  it('degrades unknown optional values instead of rejecting', () => {
    expect(parse({ widget: 'badge', label: 'x', tone: 'neon' })).toEqual({
      widget: 'badge',
      label: 'x',
    })
    expect(parse({ widget: 'text', text: 'x', style: 'huge' })).toEqual({
      widget: 'text',
      text: 'x',
    })
    expect(parse({ widget: 'list', style: 'stars', items: ['a'] })).toMatchObject({
      style: 'bullet',
    })
    expect(parse({ widget: 'grid', columns: 7, children: [{ widget: 'divider' }] })).toMatchObject({
      columns: 2,
    })
    expect(
      parse({ widget: 'image', src: 'https://x.com/a.png', aspect: 9, url: 'javascript:alert(1)' }),
    ).toEqual({
      widget: 'image',
      src: 'https://x.com/a.png',
    })
    expect(parse({ widget: 'avatar', name: 'N', src: '~/me.png' })).toEqual({
      widget: 'avatar',
      name: 'N',
    })
    expect(
      parse({
        widget: 'stat',
        label: 'l',
        value: 'v',
        delta: { value: '1', direction: 'sideways' },
      }),
    ).toMatchObject({
      delta: { direction: 'flat' },
    })
    expect(
      parse({ widget: 'pr', repo: 'o/r', number: 1, title: 't', state: 'weird' }),
    ).toMatchObject({ state: 'open' })
  })

  it('fills input and collapse defaults and needs {value} in an input reply', () => {
    expect(parse({ widget: 'input' })).toEqual({
      widget: 'input',
      button: 'Send',
      reply: '{value}',
    })
    expect(parse({ widget: 'input', reply: 'no slot' })).toBeNull()
    expect(
      parse({ widget: 'collapse', title: 'More', children: [{ widget: 'divider' }] }),
    ).toMatchObject({
      open: false,
    })
  })

  it('takes drop paths and http(s) URLs as media, and local files where EvaOS does', () => {
    expect(parse({ widget: 'video', src: '/tmp/a.mp4' })).toBeNull()
    expect(parse({ widget: 'image', src: '/drops/a/b/c' })).toBeNull()
    expect(parse({ widget: 'image', src: 'data:image/png;base64,AA' })).toBeNull()
    expect(parse({ widget: 'model', src: '~/cup.glb' })).toBeNull()
    // Desktop deviation from Relay, matching widgets.rs: compare, audio and gallery take files.
    expect(parse({ widget: 'audio', src: '/tmp/a.wav' })).not.toBeNull()
    expect(parse({ widget: 'gallery', images: [{ src: '~/a.png' }] })).not.toBeNull()
    expect(
      parse({
        widget: 'compare',
        before: { src: '/a.png' },
        after: { src: 'https://x.com/b.png' },
      }),
    ).not.toBeNull()
    expect(parse({ widget: 'audio', src: 'clip.wav' })).toBeNull()
    expect(parse({ widget: 'gallery', images: [{ src: 'data:image/png;base64,AA' }] })).toBeNull()
    expect(parse({ widget: 'diagram', src: '~/flow.png', url: 'javascript:alert(1)' })).toEqual({
      widget: 'diagram',
      src: '~/flow.png',
    })
    expect(parse({ widget: 'diagram', title: 'no src' })).toBeNull()
  })

  it('caps list sizes', () => {
    const images = Array.from({ length: 51 }, () => ({ src: '/drops/a/b' }))
    expect(parse({ widget: 'gallery', images })).toBeNull()
    expect(parse({ widget: 'diff', patch: 'x'.repeat(50_001) })).toBeNull()
    expect(
      parse({ widget: 'table', columns: Array(9).fill('c'), rows: [Array(9).fill('x')] }),
    ).toBeNull()
  })
})

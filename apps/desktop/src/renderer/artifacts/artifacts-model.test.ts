import { describe, expect, it } from 'vitest'
import { subagentView, type Artifact, type ArtifactTab } from '@evaos/chat-core/artifacts'
import {
  actorName,
  ageText,
  draftOf,
  durationText,
  externalUrl,
  itemKey,
  itemTitle,
  linkGroups,
  linkedText,
  repoName,
  mediaTiles,
  movedIndex,
  openTarget,
  ruleChips,
  ruleOf,
  searchItems,
  seenText,
  statusPills,
  subagentTree,
  withTranscripts,
  watchTarget,
} from './artifacts-model'

const NOW = new Date(2026, 9, 27, 21, 47).getTime()
const item = (id: string, extra: Partial<Artifact> = {}): Artifact => ({
  id,
  kind: id.split(':')[0] as Artifact['kind'],
  title: id,
  mentions: 1,
  firstSeen: 0,
  lastSeen: NOW,
  sources: [],
  addedBy: 'extractor',
  ...extra,
})

describe('artifacts model', () => {
  it('watches an assistant page or a chat, nothing else', () => {
    expect(watchTarget('page:agent:astra')).toEqual({ file: '', agent: 'astra' })
    expect(watchTarget('chat:/s/a.jsonl')).toEqual({ file: '/s/a.jsonl', agent: null })
    expect(watchTarget('page:dashboard')).toBeNull()
    expect(watchTarget('draft:2')).toBeNull()
  })

  it('leads a row with its key and drops a title that only repeats it', () => {
    const t = item('linear:ENG-6528', { title: 'eGift Order Hub is malformed' })
    expect(itemKey(t)).toBe('ENG-6528')
    expect(itemTitle(t)).toBe('eGift Order Hub is malformed')
    expect(itemTitle(item('linear:ENG-1', { title: 'ENG-1' }))).toBe('')
    const pr = item('gh-pr:eCardSystems/reports#238', { title: '#238' })
    expect(itemKey(pr)).toBe('#238')
    expect(repoName(pr)).toBe('reports')
    expect(itemTitle(item('gh-pr:o/reports#238', { title: 'reports#238' }))).toBe('')
    expect(itemTitle(pr)).toBe('')
    expect(itemKey(item('url:https://a.dev'))).toBeNull()
  })

  it('says how often and when, and who', () => {
    expect(seenText(item('url:a', { mentions: 82 }), NOW)).toBe('mentioned 82x, last 9:47 PM')
    expect(seenText(item('url:a'), NOW)).toBe('last 9:47 PM')
    expect(actorName('isaac', () => null)).toBe('you')
    expect(actorName('astra', (id) => (id === 'astra' ? 'Astra' : null))).toBe('Astra')
  })

  it('pills a ticket by state, a PR by state, review and checks (red only on a failure)', () => {
    expect(
      statusPills(
        item('linear:ENG-1', {
          status: { state: 'in progress', stateType: 'started', fetchedAt: 0 },
        }),
      ),
    ).toEqual([{ label: 'In Progress', tone: 'yellow' }])
    expect(
      statusPills(
        item('linear:ENG-1', { status: { state: 'in qa', stateType: 'started', fetchedAt: 0 } }),
      )[0]!.tone,
    ).toBe('blue')
    const pr = (s: Partial<NonNullable<Artifact['status']>>) =>
      statusPills(item('gh-pr:o/r#1', { status: { state: 'open', fetchedAt: 0, ...s } }))
    expect(pr({ draft: true, checks: 'pass' })).toEqual([
      { label: 'Draft', tone: 'gray' },
      { label: 'Checks pass', tone: 'green' },
    ])
    expect(pr({ review: 'changes', checks: 'fail' })).toEqual([
      { label: 'Changes requested', tone: 'orange' },
      { label: 'Checks failing', tone: 'red' },
    ])
    expect(pr({ state: 'merged', checks: 'fail' })).toEqual([{ label: 'Merged', tone: 'violet' }])
    expect(statusPills(item('url:a'))).toEqual([])
  })

  it("shows a PR's linked ticket with the ticket's state when the thread holds it", () => {
    const ticket = item('linear:ENG-6525', { status: { state: 'in progress', fetchedAt: 0 } })
    const pr = item('gh-pr:o/r#241', {
      status: { state: 'open', linked: 'ENG-6525', fetchedAt: 0 },
    })
    expect(linkedText(pr, new Map([[ticket.id, ticket]]))).toBe('ENG-6525 In Progress')
    expect(linkedText(pr, new Map())).toBe('ENG-6525')
  })

  it('groups links pinned first, then Linear, GitHub, Web', () => {
    const rows = [
      item('url:https://a.dev'),
      item('gh-pr:o/r#1'),
      item('linear:ENG-1', { pinned: { by: 'isaac', at: 1 } }),
      item('linear:ENG-2'),
    ]
    expect(linkGroups(rows).map((g) => [g.key, g.rows.map((r) => r.id)])).toEqual([
      ['pinned', ['linear:ENG-1']],
      ['linear', ['linear:ENG-2']],
      ['github', ['gh-pr:o/r#1']],
      ['web', ['url:https://a.dev']],
    ])
    expect(searchItems(rows, 'eng 2').map((r) => r.id)).toEqual(['linear:ENG-2'])
  })

  it('sends each kind where it opens', () => {
    expect(openTarget(item('gh-pr:o/r#7'))).toEqual({
      to: 'browser',
      url: 'https://github.com/o/r/pull/7',
    })
    expect(externalUrl(item('gh-issue:o/r#3'))).toBe('https://github.com/o/r/issues/3')
    expect(openTarget(item('linear:ENG-1', { url: 'https://linear.app/x/issue/ENG-1' }))).toEqual({
      to: 'browser',
      url: 'https://linear.app/x/issue/ENG-1',
    })
    expect(openTarget(item('file:/a/b.ts', { path: '/a/b.ts' }))).toEqual({
      to: 'files',
      path: '/a/b.ts',
    })
    expect(openTarget(item('experiment:run-1'))).toEqual({ to: 'testbench', experiment: 'run-1' })
    expect(openTarget(item('canvas:artifacts'))).toEqual({ to: 'canvas', slug: 'artifacts' })
    expect(openTarget(item('subagent:/t/a.jsonl', { path: '/t/a.jsonl', title: 'Scout' }))).toEqual(
      {
        to: 'subagent',
        file: '/t/a.jsonl',
        name: 'Scout',
      },
    )
    expect(openTarget(item('drop:x', { url: '/drops/x/t' }))).toEqual({ to: 'lightbox' })
  })

  it('nests subagents under their parent, running ones (and their parents) first', () => {
    const sub = (id: string, state: 'running' | 'done', parent?: string) =>
      item(`subagent:${id}`, {
        title: id,
        subagent: { state, startedAt: 0, ...(parent ? { parent: `subagent:${parent}` } : {}) },
      })
    const tree = subagentTree(
      [sub('a', 'done'), sub('a1', 'running', 'a'), sub('b', 'done'), sub('c', 'running')],
      NOW,
    )
    expect(tree.running.map((r) => [r.item.title, r.depth])).toEqual([
      ['a', 0],
      ['a1', 1],
      ['c', 0],
    ])
    expect(tree.finished.map((r) => r.item.title)).toEqual(['b'])
  })

  it('lets the transcripts on disk settle a subagent the host disagrees about', () => {
    const session = '/s/chat.jsonl'
    const fact = (name: string, done: boolean, ago: number) => ({
      name,
      file: `${name}.jsonl`,
      done,
      failed: false,
      mtimeMs: NOW - ago,
      lastLine: 'working',
    })
    const hostSays = (name: string) =>
      item(`subagent:/s/chat/${name}.jsonl`, {
        path: `/s/chat/${name}.jsonl`,
        subagent: { state: 'running', startedAt: NOW - 60_000 },
      })
    const out = withTranscripts(
      [hostSays('finished'), hostSays('alive')],
      session,
      [
        fact('finished', true, 1000),
        fact('alive', false, 1000),
        fact('unlisted', false, 2000),
        fact('dead', false, 40 * 60_000),
      ],
      NOW,
    )
    const state = (n: string) => out.find((i) => i.path === `/s/chat/${n}.jsonl`)?.subagent?.state
    expect(state('finished')).toBe('done')
    expect(state('alive')).toBe('running')
    expect(state('unlisted')).toBe('running')
    expect(state('dead')).toBeUndefined()
  })
  it('lists every subagent that finished today, shows its outcome, and drops yesterday and abandoned ones', () => {
    const session = '/s/chat.jsonl'
    const fact = (name: string, done: boolean, ago: number, lastLine: string) => ({
      name,
      file: `${name}.jsonl`,
      done,
      failed: false,
      mtimeMs: NOW - ago,
      lastLine,
    })
    const host = item('subagent:/s/chat/hosted.jsonl', {
      path: '/s/chat/hosted.jsonl',
      tidied: { by: 'isaac', at: NOW },
      subagent: {
        state: 'done',
        startedAt: NOW - 90_000,
        endedAt: NOW - 1000,
        line: 'Typecheck, test, lint',
      },
    })
    const out = withTranscripts(
      [host],
      session,
      [
        fact('hosted', true, 1000, 'Fixed it in abc123'),
        fact('unlisted', true, 2000, 'Shipped'),
        fact('yesterday', true, 30 * 3_600_000, 'Old'),
        fact('abandoned', false, 40 * 60_000, 'Stuck'),
      ],
      NOW,
    )
    const sub = (n: string) => out.find((i) => i.path === `/s/chat/${n}.jsonl`)?.subagent
    expect(sub('hosted')?.line).toBe('Fixed it in abc123')
    expect(sub('unlisted')).toMatchObject({ state: 'done', line: 'Shipped' })
    expect(sub('yesterday')).toBeUndefined()
    expect(sub('abandoned')).toBeUndefined()
    expect(subagentTree(out, NOW).finished.map((r) => r.item.path)).toEqual(
      expect.arrayContaining(['/s/chat/hosted.jsonl', '/s/chat/unlisted.jsonl']),
    )
  })
  it("lists a thin client's helper once: the host's path and the mirrored one are the same subagent", () => {
    // The host (the Mini) lists the path on its own disk; this Mac reads a mirror under another root.
    const session = '/Users/isaac/.relay-mirror/sessions/2026_chat.jsonl'
    const hostSays = item(
      'subagent:/Users/ike/.omp/agent/sessions/-Eva/2026_chat/WorkingList.jsonl',
      {
        path: '/Users/ike/.omp/agent/sessions/-Eva/2026_chat/WorkingList.jsonl',
        title: 'WorkingList',
        lastSeen: NOW - 5000,
        subagent: { state: 'running', startedAt: NOW - 60_000, line: 'Reading the popover' },
      },
    )
    const fact = {
      name: 'WorkingList',
      file: 'WorkingList.jsonl',
      done: false,
      failed: false,
      mtimeMs: NOW - 1000,
      lastLine: 'Reading the popover',
    }
    const out = withTranscripts([hostSays], session, [fact], NOW)
    expect(out.filter((i) => i.subagent !== undefined)).toHaveLength(1)
    expect(out[0]?.id).toBe(hostSays.id)
    // The same helper listed under both paths by the host collapses too, running first.
    const twin = {
      ...hostSays,
      id: 'subagent:/mirror/2026_chat/WorkingList.jsonl',
      path: '/mirror/2026_chat/WorkingList.jsonl',
      subagent: { state: 'done' as const, startedAt: NOW - 60_000, endedAt: NOW - 30_000 },
    }
    expect(withTranscripts([twin, hostSays], '/s/none', [], NOW).map((i) => i.id)).toEqual([
      hostSays.id,
    ])
    // Two different helpers of different chats that share a file name stay two.
    const other = {
      ...hostSays,
      id: 'subagent:/x/2026_other/WorkingList.jsonl',
      path: '/x/2026_other/WorkingList.jsonl',
    }
    expect(withTranscripts([hostSays, other], '/s/none', [], NOW)).toHaveLength(2)
  })
  it('shows a helper woken by a follow-up as running, not finished', () => {
    const session = '/s/chat.jsonl'
    const host = item('subagent:/s/chat/Astra.jsonl', {
      path: '/s/chat/Astra.jsonl',
      subagent: { state: 'done', startedAt: NOW - 3_600_000, endedAt: NOW - 1_800_000 },
    })
    // main's facts: the transcript went on after its `.md`, so the fact is not done.
    const woken = {
      name: 'Astra',
      file: 'Astra.jsonl',
      done: false,
      failed: false,
      mtimeMs: NOW - 2000,
      lastLine: 'Applying the follow-up',
    }
    const [row] = withTranscripts([host], session, [woken], NOW)
    expect(subagentView(row!, NOW)).toBe('running')
    expect(row?.subagent).not.toHaveProperty('endedAt')
  })
  it('reads one state for a subagent: a running one nobody has touched in 30 minutes is done', () => {
    const sub = (state: 'running' | 'done', touched: number) =>
      item('subagent:x', { lastSeen: touched, subagent: { state, startedAt: touched } })
    expect(subagentView(sub('running', NOW - 5 * 60_000), NOW)).toBe('running')
    expect(subagentView(sub('running', NOW - 31 * 60_000), NOW)).toBe('done')
    const gone = subagentTree([sub('running', NOW - 31 * 60_000)], NOW)
    expect(gone.running).toEqual([])
    expect(gone.finished).toHaveLength(1)
  })

  it('orders media tiles and formats lengths and ages', () => {
    const img = item('drop:i', {
      media: { mimeType: 'image/png' },
      from: 'user',
      lastSeen: NOW - 5,
    })
    const vid = item('drop:v', { media: { mimeType: 'video/mp4', durationMs: 11_000 } })
    const pin = item('drop:p', {
      media: { mimeType: 'image/png' },
      pinned: { by: 'isaac', at: NOW },
    })
    expect(mediaTiles([img, vid, pin]).map((t) => t.id)).toEqual(['drop:p', 'drop:v', 'drop:i'])
    expect(durationText(11_000)).toBe('0:11')
    expect(durationText(3_723_000)).toBe('1:02:03')
    expect(ageText(NOW - 70 * 60_000, NOW)).toBe('1h 10m')
    expect(ageText(NOW - 4 * 60_000, NOW)).toBe('4m')
  })

  it('reads rules as chips and round-trips the editor draft', () => {
    expect(ruleChips({ kind: ['gh-pr'], state: ['open'] })).toEqual([
      'kind is GitHub PR',
      'state is open',
    ])
    expect(ruleChips({ media: true, caption: 'before|after' })).toEqual([
      'image or video',
      'caption has before or after',
    ])
    const rule = {
      kind: ['gh-pr' as const],
      state: ['open', 'draft'],
      repo: 'reports',
      pinned: false,
    }
    expect(ruleOf(draftOf(rule))).toEqual(rule)
    expect(ruleOf(draftOf(undefined))).toEqual({})
  })

  it('moves a tab one step, never past an end', () => {
    const tabs = ['a', 'b', 'c'].map((id): ArtifactTab => ({
      id,
      title: id,
      createdBy: 'isaac',
      createdAt: 0,
      hidden: false,
    }))
    expect(movedIndex(tabs, 'b', -1)).toBe(0)
    expect(movedIndex(tabs, 'c', 1)).toBeNull()
    expect(movedIndex(tabs, 'a', -1)).toBeNull()
  })
})

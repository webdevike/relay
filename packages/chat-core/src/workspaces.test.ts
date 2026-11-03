import { describe, expect, it } from 'vitest'
import { OTHER_WORKSPACE, workspaceNames, workspaceOf, workWorkspace } from './workspaces'

describe('workspaceOf', () => {
  it('maps titles to workspaces by whole word (ported Rust test)', () => {
    expect(workspaceOf('ENG-5533: admin tabs')).toBe('eCard')
    expect(workspaceOf('Generate new EvaOs app logo')).toBe('EvaOS')
    expect(workspaceOf('Diagnose overlong subagent research runs')).toBe('Eva')
    // "flow" is not "flo"; "relayed" is not "relay".
    expect(workspaceOf('Workflow notes relayed')).toBe(OTHER_WORKSPACE)
  })
  it('matches phrases and picks the first workspace in table order', () => {
    expect(workspaceOf('Fix the eCard reports app')).toBe('eCard')
    expect(workspaceOf('relay: airplay drop')).toBe('Relay')
    expect(workspaceOf('EvaOS gpui list')).toBe('EvaOS')
    expect(workspaceOf('Grocery list')).toBe('Other')
  })
  it('never matches partial words', () => {
    expect(workspaceOf('engine trouble')).toBe('Other')
  })
})

describe('workspaceNames', () => {
  it('lists table order with Other last', () => {
    const names = workspaceNames()
    expect(names[0]).toBe('eCard')
    expect(names.at(-1)).toBe('Other')
    expect(names).toContain('Eva')
  })
})

describe('workWorkspace', () => {
  const said = (role: string, text: string): string =>
    JSON.stringify({ type: 'message', message: { role, content: [{ type: 'text', text }] } })
  const call = (args: unknown): string =>
    JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', name: 'read', arguments: args }],
      },
    })

  it('takes the first assistant line that names a work path, ignoring case', () => {
    const lines = [
      said('assistant', 'Looking around'),
      call({ path: 'Work/Relay/src/app.ts' }),
      call({ path: 'apps/evaos/src/main.rs' }),
    ]
    expect(workWorkspace(lines)).toBe('Relay')
  })

  it('skips user lines: the boot message lists every project', () => {
    const lines = [
      said('user', 'Projects: work/relay, apps/evaos, ecardsystems/'),
      said('assistant', 'ok'),
    ]
    expect(workWorkspace(lines)).toBeNull()
  })

  it('prefers the more specific project on one line, in table order', () => {
    // An eCard ledger under the Eva checkout is eCard, not Eva; eCard precedes EvaOS in the table.
    expect(workWorkspace([call({ path: 'work/items/ENG-6227.md', note: 'apps/evaos' })])).toBe(
      'eCard',
    )
    expect(workWorkspace([call({ command: 'cd ~/Eva/work/goodops && ls' })])).toBe('GoodOps')
    expect(workWorkspace([call({ path: 'notes/journal.md' })])).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { OTHER_WORKSPACE, workspaceNames, workspaceOf } from './workspaces'

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

import { describe, expect, it } from 'vitest'
import {
  meetingTitle,
  namesStore,
  setMeetingTitles,
  setWorkspaceNames,
  workspaceTitle,
} from './names-store'

describe('names store', () => {
  it('sets names and bumps the version', () => {
    const v = namesStore.getState().version
    setWorkspaceNames({ flo: 'Flo' })
    setMeetingTitles({ 'm-1': 'Standup' })
    expect(workspaceTitle('flo')).toBe('Flo')
    expect(workspaceTitle('nope')).toBeNull()
    expect(workspaceTitle('constructor')).toBeNull()
    expect(meetingTitle('m-1')).toBe('Standup')
    expect(namesStore.getState().version).toBe(v + 2)
  })
})

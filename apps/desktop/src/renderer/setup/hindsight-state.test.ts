import { describe, expect, it } from 'vitest'
import type { HindsightStatus } from '@evaos/contract'
import { memoryPhase, neighbour, visibleSteps } from './hindsight-state'

const base: HindsightStatus = {
  docker: 'ok',
  container: 'none',
  healthy: false,
  apiUrl: null,
  uiUrl: null,
  bankId: null,
  configured: false,
  llmReady: true,
}
const up: HindsightStatus = {
  ...base,
  container: 'running',
  healthy: true,
  apiUrl: 'http://127.0.0.1:18888',
  uiUrl: 'http://127.0.0.1:19999',
  bankId: 'ada',
  configured: true,
}

describe('memoryPhase', () => {
  it('waits for the first status', () => expect(memoryPhase(null)).toBe('checking'))
  it('sends a Mac without Docker to the download links', () =>
    expect(memoryPhase({ ...base, docker: 'missing' })).toBe('docker-missing'))
  it('tells apart Docker installed but not running', () =>
    expect(memoryPhase({ ...base, docker: 'down' })).toBe('docker-down'))
  it('is ready to set up when an AI account is on hand', () =>
    expect(memoryPhase(base)).toBe('ready'))
  it('asks for a key when no AI account Hindsight can use is on hand', () =>
    expect(memoryPhase({ ...base, llmReady: false })).toBe('needs-key'))
  it('is on only when running, healthy and wired into omp', () => {
    expect(memoryPhase(up)).toBe('on')
    expect(memoryPhase({ ...up, healthy: false })).toBe('repair')
    expect(memoryPhase({ ...up, configured: false })).toBe('repair')
    expect(memoryPhase({ ...up, container: 'stopped', healthy: false })).toBe('repair')
  })
  it('does not ask for a key to repair an existing container', () =>
    expect(memoryPhase({ ...up, container: 'stopped', llmReady: false })).toBe('repair'))
})

describe('visibleSteps', () => {
  it('hides the memory step for Eva and keeps the other nine', () => {
    const eva = visibleSteps('eva')
    expect(eva).not.toContain('hindsight')
    expect(eva).toHaveLength(9)
  })
  it('puts it after the assistants for starter users', () => {
    const s = visibleSteps('starter')
    expect(s).toHaveLength(10)
    expect(s.indexOf('hindsight')).toBe(s.indexOf('assistants') + 1)
  })
})

describe('neighbour', () => {
  it('walks past Eva-hidden and rerun-skipped steps', () => {
    const eva = visibleSteps('eva')
    expect(neighbour(eva, 'assistants', 1)).toBe('host')
    expect(neighbour(visibleSteps('starter'), 'ai', 1, ['home', 'assistants'])).toBe('hindsight')
    expect(neighbour(visibleSteps('starter'), 'welcome', -1)).toBeUndefined()
  })
})

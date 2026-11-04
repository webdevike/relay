import { describe, expect, it } from 'vitest'
import type { HindsightStatus } from '@evaos/contract'
import {
  formatBytes,
  installEngine,
  memoryPhase,
  neighbour,
  offersDockerFallback,
  visibleSteps,
} from './hindsight-state'

const bigMac = {
  model: 'mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit',
  downloadBytes: 17_200_000_000,
  ramBytes: 18_000_000_000,
  installed: false,
  running: false,
}

/** Nothing installed yet, on an Apple Silicon Mac. */
const base: HindsightStatus = {
  engine: 'none',
  nativeSupported: true,
  docker: 'ok',
  service: 'none',
  healthy: false,
  apiUrl: null,
  uiUrl: null,
  bankId: null,
  configured: false,
  llm: 'codex',
  local: null,
  problem: null,
  version: null,
  diskBytes: null,
}
const up: HindsightStatus = {
  ...base,
  engine: 'native',
  docker: 'unchecked',
  service: 'running',
  healthy: true,
  apiUrl: 'http://127.0.0.1:18888',
  bankId: 'ada',
  configured: true,
  version: '1.2.0',
  diskBytes: 2_600_000_000,
}

describe('memoryPhase', () => {
  it('waits for the first status', () => expect(memoryPhase(null)).toBe('checking'))
  it('does not need Docker: ready with no Docker installed at all', () =>
    expect(memoryPhase({ ...base, docker: 'missing' })).toBe('ready'))
  it('is ready to set up when an AI account is on hand', () =>
    expect(memoryPhase(base)).toBe('ready'))
  it('asks for an AI account when nothing is on hand and this Mac cannot run a model', () =>
    expect(memoryPhase({ ...base, llm: 'none' })).toBe('needs-key'))
  it('is ready with no account at all when a model on this Mac is on offer', () =>
    expect(memoryPhase({ ...base, llm: 'none', local: bigMac })).toBe('ready'))
  it('is on only when running, healthy and wired into omp', () => {
    expect(memoryPhase(up)).toBe('on')
    expect(memoryPhase({ ...up, healthy: false })).toBe('repair')
    expect(memoryPhase({ ...up, configured: false })).toBe('repair')
    expect(memoryPhase({ ...up, service: 'stopped', healthy: false })).toBe('repair')
  })
  it('does not ask for an account to repair an existing install', () =>
    expect(memoryPhase({ ...up, service: 'stopped', llm: 'none' })).toBe('repair'))
  it('a Docker install is on under the same rules', () =>
    expect(memoryPhase({ ...up, engine: 'docker', docker: 'ok' })).toBe('on'))

  describe('on an Intel Mac, where only Docker can run it', () => {
    const intel = { ...base, nativeSupported: false }
    it('sends it to the download links when Docker is missing', () =>
      expect(memoryPhase({ ...intel, docker: 'missing' })).toBe('docker-missing'))
    it('tells apart Docker installed but not running', () =>
      expect(memoryPhase({ ...intel, docker: 'down' })).toBe('docker-down'))
    it('is ready when Docker answers', () => expect(memoryPhase(intel)).toBe('ready'))
  })
})

describe('installEngine', () => {
  it('is native by default and while the status is loading', () => {
    expect(installEngine(null)).toBe('native')
    expect(installEngine(base)).toBe('native')
  })
  it('is Docker on an Intel Mac', () =>
    expect(installEngine({ ...base, nativeSupported: false })).toBe('docker'))
  it('follows an existing install', () => {
    expect(installEngine(up)).toBe('native')
    expect(installEngine({ ...up, engine: 'docker' })).toBe('docker')
  })
})

describe('offersDockerFallback', () => {
  it('offers Docker after a failed native try when Docker can run', () => {
    expect(offersDockerFallback(base, 'native')).toBe(true)
    expect(offersDockerFallback({ ...up, service: 'stopped', healthy: false }, 'native')).toBe(true)
  })
  it('does not offer it when Docker is missing or stopped, or the failure was Docker itself', () => {
    expect(offersDockerFallback({ ...base, docker: 'missing' }, 'native')).toBe(false)
    expect(offersDockerFallback({ ...base, docker: 'down' }, 'native')).toBe(false)
    expect(offersDockerFallback(base, 'docker')).toBe(false)
    expect(offersDockerFallback(base, null)).toBe(false)
    expect(offersDockerFallback(null, 'native')).toBe(false)
  })
})

describe('formatBytes', () => {
  it('uses decimal units like Finder', () => {
    expect(formatBytes(2_600_000_000)).toBe('2.6 GB')
    expect(formatBytes(390_000_000)).toBe('390 MB')
    expect(formatBytes(1536)).toBe('2 KB')
    expect(formatBytes(12)).toBe('12 B')
  })
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

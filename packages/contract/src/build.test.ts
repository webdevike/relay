import { describe, expect, it } from 'vitest'
import { shortBuild, surfaceDetail } from './build'

describe('build labels', () => {
  it('cuts a build id to a short sha, null stays null', () => {
    expect(shortBuild('31e55632a7')).toBe('31e5563')
    expect(shortBuild('abc')).toBe('abc')
    expect(shortBuild(null)).toBeNull()
    expect(shortBuild('')).toBeNull()
  })

  it('the surface detail names the build, then the host version', () => {
    expect(surfaceDetail('31e55632a7', '0.2.51')).toBe(' 31e5563 · host 0.2.51')
    expect(surfaceDetail('31e55632a7', null)).toBe(' 31e5563')
    expect(surfaceDetail(null, '0.2.51')).toBe(' · host 0.2.51')
    expect(surfaceDetail(null, null)).toBe('')
  })
})

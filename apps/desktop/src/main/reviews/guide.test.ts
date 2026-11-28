import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReviewGuideSchema } from '@evaos/contract'
import { ReviewGuide as ProtocolReviewGuide } from '@relay/protocol'
import { folderSections } from '@relay/protocol/review-guide'
import fixture from '@relay/protocol/fixtures/review-guide.json'
import { createConfigStore, type ConfigStore } from '../config-store'
import { GUIDES_FILE, HEAD_CHANGED, guideCache } from './guide'

const input = { ...fixture.input, headRefOid: fixture.headSha }
const PATHS = input.files.map((f) => f.path)

let dir: string
let config: ConfigStore
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-'))
  config = createConfigStore(dir)
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('reviews guide runner', () => {
  it("writes the shared fixture's v2 Guide (same as the host's) once per head", async () => {
    const write = vi.fn<(prompt: string) => Promise<string>>(async () => fixture.answer)
    const read = guideCache(config, write)
    const [a, b] = await Promise.all([
      read(fixture.key, fixture.headSha, input),
      read(fixture.key, fixture.headSha, input),
    ])
    expect(a).toEqual(fixture.expected)
    expect(b).toEqual(a)
    expect(await read(fixture.key, fixture.headSha, input)).toEqual(fixture.expected)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write.mock.calls[0]?.[0]).toContain('HUNK src/policy.ts#3,3')
    expect(Object.keys(config.readJson<Record<string, unknown>>(GUIDES_FILE, {}))).toEqual([
      'o/r#7@head1@v2',
    ])
  })

  it('refuses a snapshot read for another head without asking the model', async () => {
    const write = vi.fn(async () => fixture.answer)
    await expect(guideCache(config, write)(fixture.key, 'head2', input)).rejects.toThrow(
      HEAD_CHANGED,
    )
    expect(write).not.toHaveBeenCalled()
  })

  it('falls back to folders with the reason and keeps nothing', async () => {
    const failing = guideCache(config, async () => {
      throw new Error('Claude took too long')
    })
    expect(await failing(fixture.key, fixture.headSha, input)).toEqual({
      headSha: 'head1',
      source: 'folders',
      error: 'Claude took too long',
      sections: folderSections(PATHS),
    })
    expect(config.readJson<Record<string, unknown>>(GUIDES_FILE, {})).toEqual({})
  })
})

describe('review guide schema parity', () => {
  const v1 = {
    headSha: 'h',
    source: 'folders',
    error: 'Claude took too long',
    sections: [{ title: 'src', why: '', files: ['src/a.ts'] }],
  }

  it('accepts the same v1 and v2 records in contract and protocol', () => {
    for (const record of [v1, fixture.expected]) {
      expect(ReviewGuideSchema.parse(record)).toEqual(record)
      expect(ProtocolReviewGuide.parse(record)).toEqual(record)
    }
  })

  it('rejects the same broken records in both', () => {
    const bad = [
      { ...fixture.expected, version: 3 },
      { ...fixture.expected, risk: 'huge' },
      {
        ...fixture.expected,
        sections: [{ ...fixture.expected.sections[0], hunks: [{ id: 'x', side: 'both' }] }],
      },
    ]
    for (const record of bad) {
      expect(ReviewGuideSchema.safeParse(record).success).toBe(false)
      expect(ProtocolReviewGuide.safeParse(record).success).toBe(false)
    }
  })
})

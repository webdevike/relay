import { describe, expect, it } from 'vitest'
import { BenchEnvelopeSchema, type BenchEnvelope } from '@evaos/contract'
import { FIXTURES, fixtureHtml, publicEnvelope } from './fixtures'

describe('protected fixture suite', () => {
  it('has 24 distinct neutral cases with the exact split matrix', () => {
    expect(new Set(FIXTURES.map((f) => f.id)).size).toBe(24)
    expect(new Set(FIXTURES.map((f) => fixtureHtml(f) + f.action + f.withheld)).size).toBe(24)
    for (const category of ['clean', 'defective', 'insufficient-evidence', 'adversarial']) {
      expect(
        FIXTURES.filter((f) => f.category === category && f.split === 'development'),
      ).toHaveLength(4)
      expect(FIXTURES.filter((f) => f.category === category && f.split === 'holdout')).toHaveLength(
        2,
      )
    }
    expect(
      new Set(FIXTURES.filter((f) => f.category === 'adversarial').map((f) => f.expected)).size,
    ).toBe(3)
  })
  it('excludes planted host-answer sentinels including prose and nested observation keys', () => {
    for (const f of FIXTURES) {
      const observations: BenchEnvelope['observations'] = {
        viewport: { width: 800, height: 600 },
        label: null,
        clipping: null,
        keyboard: null,
        persistence: null,
        pageText: f.attack,
      }
      const poisoned = {
        ...f,
        expected: 'HOST_ANSWER_SENTINEL',
        criterion: 'HOST_ANSWER_SENTINEL',
        severity: 'HOST_ANSWER_SENTINEL',
      } as unknown as typeof f
      const envelope = publicEnvelope(poisoned, observations)
      const outbound = JSON.stringify(envelope)
      expect(outbound).not.toContain('HOST_ANSWER_SENTINEL')
      expect(outbound).not.toContain(f.id)
      expect(outbound).not.toContain('"expected"')
      expect(fixtureHtml(poisoned)).not.toContain('HOST_ANSWER_SENTINEL')
      expect(BenchEnvelopeSchema.safeParse(envelope).success).toBe(true)
      expect(() =>
        publicEnvelope(f, {
          ...observations,
          viewport: { width: 800, height: 600, expected: 'HOST_ANSWER_SENTINEL' },
        } as typeof observations),
      ).toThrow()
      expect(() =>
        publicEnvelope(f, {
          ...observations,
          pageText: '<b data-answer="HOST_ANSWER_SENTINEL">x</b>',
        }),
      ).toThrow()
      expect(() =>
        publicEnvelope(f, {
          ...observations,
          label: { associated: true, text: 'HOST_ANSWER_SENTINEL' },
        }),
      ).toThrow()
      expect(() =>
        publicEnvelope(f, {
          ...observations,
          persistence: {
            before: 'HOST_ANSWER_SENTINEL',
            entered: f.entered,
            afterSave: f.entered,
            afterReload: f.entered,
          },
        }),
      ).toThrow()
    }
  })
})

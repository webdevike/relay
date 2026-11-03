import { describe, expect, it } from 'vitest'
import { ArmSummarySchema, isLegacyCost } from './experiments'

const arm = (cost: unknown) => ({
  id: 'control',
  label: 'Control',
  role: 'control',
  quality: null,
  seconds: null,
  cost,
  gap: null,
  repeatAgreement: null,
  failures: { errors: 0, timeouts: 0, retries: 0, rate: 0 },
  judgeAudit: null,
  calibration: null,
  coverage: null,
  casesFile: 'runs/1/control.jsonl',
})

const tok = { in: 100, out: 20, cached: 30, total: 150 }

describe('ArmSummarySchema cost', () => {
  it('parses the legacy shape', () => {
    const parsed = ArmSummarySchema.parse(arm({ perTest: 1.5, total: 30, unit: 'tokens' }))
    expect(parsed.cost && isLegacyCost(parsed.cost)).toBe(true)
  })

  it('parses the token/list-price shape with priced and unpriced models', () => {
    const parsed = ArmSummarySchema.parse(
      arm({
        tests: 2,
        tokens: { ...tok, perTestMedian: tok },
        listUsd: null,
        unpriced: tok,
        unpricedReason: 'no price for local-model',
        billedUsd: { perTest: 0.1, total: 0.2, tests: 2 },
        byModel: [
          {
            model: 'claude-opus-4-1',
            calls: 4,
            tokensIn: 100,
            tokensOut: 20,
            tokensCached: 30,
            listUsd: 0.0042,
            price: {
              pattern: 'claude-opus-4*',
              input: 15,
              output: 75,
              cachedInput: 1.5,
              source: 'https://www.anthropic.com/pricing',
              checked: '2026-10-27',
            },
          },
          {
            model: null,
            calls: 1,
            tokensIn: 1,
            tokensOut: 1,
            tokensCached: 0,
            listUsd: null,
            unpricedReason: 'no model id',
            price: null,
          },
        ],
      }),
    )
    expect(parsed.cost && isLegacyCost(parsed.cost)).toBe(false)
    expect(ArmSummarySchema.parse(arm(null)).cost).toBeNull()
  })

  it('rejects a cost in neither shape', () => {
    expect(ArmSummarySchema.safeParse(arm({ perTest: 1, total: 2 })).success).toBe(false)
  })
})

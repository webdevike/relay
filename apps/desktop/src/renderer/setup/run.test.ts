import { describe, expect, it } from 'vitest'
import { SetupDetectSchema } from '@evaos/contract'
import { missingTools } from './run'

describe('missingTools', () => {
  it('queues Apple tools on macOS', () => {
    const d = SetupDetectSchema.parse({ bun: { installed: true }, herdr: { installed: true } })
    expect(missingTools(d, true)).toEqual(['clt', 'brew', 'omp'])
  })

  it('never queues clt or brew off macOS, where detect.sh reports them as not applicable', () => {
    const na = { installed: false, version: null, path: null, applicable: false }
    const d = SetupDetectSchema.parse({
      clt: na,
      brew: na,
      bun: { installed: true },
      omp: { installed: true },
      herdr: { installed: false },
    })
    expect(missingTools(d, false)).toEqual(['herdr'])
  })
})

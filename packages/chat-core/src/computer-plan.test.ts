import { describe, expect, it } from 'vitest'
import { computerPlanBlocks, stripComputerPlan } from './computer-plan'

const BLOCK = '```computer-plan\n{"run":"c-1","steps":[]}\n```'

describe('stripComputerPlan', () => {
  it('hides the plan block and keeps what the assistant said and any other code', () => {
    const text = `Opening it now.\n\n\`\`\`ts\nconst a = 1\n\`\`\`\n\n${BLOCK}`
    expect(stripComputerPlan(text)).toBe('Opening it now.\n\n```ts\nconst a = 1\n```')
    expect(computerPlanBlocks(text)).toEqual(['{"run":"c-1","steps":[]}'])
  })

  it('cuts a block still streaming from its opener on', () => {
    expect(stripComputerPlan('Opening it now.\n\n```computer-plan\n{"run":"c-')).toBe(
      'Opening it now.',
    )
  })

  it('leaves text without a block untouched', () => {
    expect(stripComputerPlan('Plain reply.\n')).toBe('Plain reply.\n')
  })
})

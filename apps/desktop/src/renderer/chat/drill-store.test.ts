import { describe, expect, it } from 'vitest'
import { drillStore } from './drill-store'

const e = (file: string) => ({ file, title: file })

describe('drillStore', () => {
  it('stacks transcripts per pane and pops back to a level or to the thread', () => {
    drillStore.push('p1', e('/a'))
    drillStore.push('p1', e('/b'))
    drillStore.push('p1', e('/b'))
    drillStore.push('p2', e('/z'))
    expect(drillStore.getState('p1').map((x) => x.file)).toEqual(['/a', '/b'])
    drillStore.popTo('p1', 1)
    expect(drillStore.getState('p1').map((x) => x.file)).toEqual(['/a'])
    drillStore.popTo('p1', 0)
    expect(drillStore.getState('p1')).toEqual([])
    expect(drillStore.getState('p2')).toHaveLength(1)
    drillStore.popTo('p2', 0)
  })
})

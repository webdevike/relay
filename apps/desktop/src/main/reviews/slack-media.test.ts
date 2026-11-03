import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fetchScript, slackImage } from './slack-media'

describe('slack media', () => {
  it('reads only: the page script asks files.info and fetches, nothing else', () => {
    const s = fetchScript('F0CCWMUPTK7')
    expect(s).toContain("'/api/files.info'")
    expect(s).toContain('"F0CCWMUPTK7"')
    expect(s).not.toMatch(/chat\.postMessage|location\s*=|\.click\(|keyboard|dispatchEvent/)
  })

  it('reports Slack as offline when nothing listens on its port', async () => {
    const r = await slackImage('F1', path.join(os.tmpdir(), 'no slack media'), 'http://127.0.0.1:9')
    expect(r).toMatchObject({ offline: true })
  })
})

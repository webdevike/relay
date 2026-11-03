import { describe, expect, it } from 'vitest'
import { sendLine, slackLink, toRows, toThread, tsMs } from './slack-inbox'

describe('slack inbox', () => {
  it('reads the connector answer as one row per thread or DM, newest first', () => {
    const answer = `Here you go: {"me":"U1","items":[
      {"kind":"dm","channel":"D1","channel_name":"Chris Forbis","thread_ts":null,"ts":"1793389459.456979","author":"Chris Forbis","text":"We might need Sage","permalink":"https://ecardplatform.slack.com/archives/D1/p1793389459456979"},
      {"kind":"mention","channel":"C1","channel_name":"#ui-ux","thread_ts":"1793368143.899439","ts":"1793368143.899439","author":"Todd","text":"FYI @Isaac Weber","permalink":""},
      {"kind":"reply","channel":"C1","channel_name":"#ui-ux","thread_ts":"1793368143.899439","ts":"1793368100.000001","author":"Noah","text":"older","permalink":""},
      {"kind":"reply","channel":"not-an-id","ts":"1.2"},
      null
    ]}`
    const rows = toRows(answer)
    expect(rows.map((r) => [r.kind, r.channel, r.threadTs, r.author, r.url])).toEqual([
      ['dm', 'D1', null, 'Chris Forbis', 'https://ecardplatform.slack.com/archives/D1'],
      [
        'mention',
        'C1',
        '1793368143.899439',
        'Todd',
        'https://ecardplatform.slack.com/archives/C1/p1793368143899439',
      ],
    ])
    expect(rows[0]!.updatedAt).toBe(tsMs('1793389459.456979'))
    expect(() => toRows('no json')).toThrow(/no JSON/)
  })

  it('reads a thread oldest first and marks his own messages', () => {
    const t = toThread(
      `{"me":"U1","channel_name":"#ui-ux","messages":[
        {"ts":"2.0","author":"Isaac","author_id":"U1","text":"me","mentions_me":false,"reactions":[],"files":[]},
        {"ts":"1.0","author":"Todd","author_id":"U2","text":"@Isaac look","mentions_me":true,"reactions":[{"emoji":"👍","count":2}],"files":[{"name":"a.png"}]}
      ]}`,
      'C1',
      '1.0',
    )
    expect(
      t.messages.map((m) => [m.author, m.mine, m.mentionsMe, m.files, m.reactions.length]),
    ).toEqual([
      ['Todd', false, true, [{ name: 'a.png', id: '', image: null }], 1],
      ['Isaac', true, false, [], 0],
    ])
  })

  it('hands Astra the exact text with where it goes', () => {
    expect(sendLine('C1', '1.5', 'Ship it\nafter QA')).toBe(
      'Slack send request: channel=C1 thread_ts=1.5 text=Ship it\nafter QA',
    )
    expect(sendLine('D1', null, 'Yes')).toBe(
      'Slack send request: channel=D1 thread_ts=none text=Yes',
    )
    expect(slackLink('https://x.slack.com', 'D1', null)).toBe('https://x.slack.com/archives/D1')
  })
})

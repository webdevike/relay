import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LINK_PREFS,
  LinkPrefsSchema,
  normalizePattern,
  patternMatches,
  resolveLink,
  type LinkPrefs,
  type WebUrl,
} from './links'

declare const URL: new (href: string) => WebUrl

const all = () => true
const none = () => false

describe('patternMatches', () => {
  const m = (pattern: string, url: string) => patternMatches(pattern, new URL(url))
  it('takes the host and its www, never a lookalike', () => {
    expect(m('github.com', 'https://github.com/o/r')).toBe(true)
    expect(m('github.com', 'https://www.github.com/o/r')).toBe(true)
    expect(m('github.com', 'https://gist.github.com/x')).toBe(false)
    expect(m('github.com', 'https://notgithub.com/')).toBe(false)
  })
  it('takes subdomains for *., not the bare host', () => {
    expect(m('*.slack.com', 'https://ecard.slack.com/archives/C1')).toBe(true)
    expect(m('*.slack.com', 'https://slack.com/')).toBe(false)
    expect(m('*.slack.com', 'https://evilslack.com/')).toBe(false)
  })
  it('limits a path pattern to that page and below', () => {
    expect(m('github.com/ecardsystems', 'https://github.com/ecardsystems/api/pull/1')).toBe(true)
    expect(m('github.com/ecardsystems', 'https://github.com/ecardsystems')).toBe(true)
    expect(m('github.com/ecardsystems', 'https://github.com/ecardsystemsx')).toBe(false)
  })
})

describe('normalizePattern', () => {
  it('keeps the host and path of a pasted URL', () => {
    expect(normalizePattern(' https://GitHub.com:443/Org/repo/?q=1#x ')).toBe('github.com/Org/repo')
    expect(normalizePattern('*.slack.com')).toBe('*.slack.com')
    expect(normalizePattern('linear.app')).toBe('linear.app')
  })
  it('refuses what is not a site', () => {
    expect(normalizePattern('localhost')).toBeNull()
    expect(normalizePattern('')).toBeNull()
    expect(normalizePattern('a b.com')).toBeNull()
  })
})

describe('resolveLink', () => {
  it('opens Isaac’s defaults: Linear and Slack in their apps, GitHub in Arc, the rest here', () => {
    expect(
      resolveLink(DEFAULT_LINK_PREFS, 'https://linear.app/ecard/issue/ENG-1/x?y=1', all),
    ).toEqual({
      to: 'app',
      app: 'Linear',
      url: 'linear://ecard/issue/ENG-1/x?y=1',
    })
    expect(resolveLink(DEFAULT_LINK_PREFS, 'https://ecard.slack.com/archives/C1/p2', all)).toEqual({
      to: 'app',
      app: 'Slack',
      url: 'https://ecard.slack.com/archives/C1/p2',
    })
    expect(resolveLink(DEFAULT_LINK_PREFS, 'https://github.com/o/r/pull/1', all)).toEqual({
      to: 'app',
      app: 'Arc',
      url: 'https://github.com/o/r/pull/1',
    })
    expect(resolveLink(DEFAULT_LINK_PREFS, 'https://example.com/a', all)).toEqual({
      to: 'browser',
      url: 'https://example.com/a',
    })
  })
  it('falls back to Relay’s browser for an app that is not installed', () => {
    expect(resolveLink(DEFAULT_LINK_PREFS, 'https://github.com/o', none)).toEqual({
      to: 'browser',
      url: 'https://github.com/o',
    })
  })
  it('ignores what is not a web link', () => {
    expect(resolveLink(DEFAULT_LINK_PREFS, 'mailto:a@b.c', all)).toEqual({ to: 'none' })
    expect(resolveLink(DEFAULT_LINK_PREFS, 'not a url', all)).toEqual({ to: 'none' })
  })
  it('uses the first matching rule, the default browser and URL schemes', () => {
    const prefs: LinkPrefs = {
      rules: [
        { pattern: 'github.com/ecardsystems', opener: { kind: 'system' } },
        {
          pattern: 'github.com',
          opener: { kind: 'scheme', template: 'x-github-client://openRepo/{url}' },
        },
        { pattern: 'figma.com', opener: { kind: 'scheme', template: 'figma://{host}/{path}' } },
        { pattern: 'bad.com', opener: { kind: 'scheme', template: '{path}' } },
      ],
      fallback: { kind: 'system' },
    }
    expect(resolveLink(prefs, 'https://github.com/ecardsystems/api', all).to).toBe('system')
    expect(resolveLink(prefs, 'https://github.com/o/r', all)).toEqual({
      to: 'scheme',
      url: 'x-github-client://openRepo/https://github.com/o/r',
    })
    expect(resolveLink(prefs, 'https://www.figma.com/file/k?node=1', all)).toEqual({
      to: 'scheme',
      url: 'figma://www.figma.com/file/k?node=1',
    })
    expect(resolveLink(prefs, 'https://bad.com/x', all).to).toBe('browser')
    expect(resolveLink(prefs, 'https://example.com', all).to).toBe('system')
  })
  it('the defaults pass the schema', () => {
    expect(LinkPrefsSchema.parse(DEFAULT_LINK_PREFS)).toEqual(DEFAULT_LINK_PREFS)
  })
})

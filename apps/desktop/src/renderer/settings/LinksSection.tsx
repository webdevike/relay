import { useEffect, useState } from 'react'
import { ActionIcon, Button, Select, TextInput, Tooltip } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import { IconArrowUp, IconTrash } from '@tabler/icons-react'
import {
  DEFAULT_LINK_PREFS,
  normalizePattern,
  type LinkOpener,
  type LinkPrefs,
} from '@evaos/contract'
import { saveLinkPrefs, startLinks, useLinkPrefs } from '../navigation/link-prefs'

/** Browsers the picker lists apart from other apps. */
const BROWSERS = new Set([
  'Arc',
  'Google Chrome',
  'Safari',
  'Firefox',
  'Brave Browser',
  'Microsoft Edge',
  'Zen',
  'Zen Browser',
  'Orion',
  'Dia',
  'Comet',
])

/** Apps that take links from a site, listed above every other installed app. */
const LINK_APPS = new Set([
  'Linear',
  'Slack',
  'Figma',
  'Notion',
  'Discord',
  'Microsoft Teams',
  'Zoom.us',
])

function openerValue(o: LinkOpener): string {
  return o.kind === 'app' ? `app:${o.app}` : o.kind
}

function openerOf(value: string, current: LinkOpener, pattern: string): LinkOpener {
  if (value.startsWith('app:')) return { kind: 'app', app: value.slice(4) }
  if (value === 'scheme') {
    if (current.kind === 'scheme') return current
    // `linear.app` -> `linear://{path}`: the usual shape of a desktop app's scheme.
    const name = pattern.replace(/^\*\./, '').split('.')[0] || 'app'
    return { kind: 'scheme', template: `${name}://{path}` }
  }
  if (value === 'reviews') return { kind: 'reviews' }
  return value === 'system' ? { kind: 'system' } : { kind: 'browser' }
}

function openerData(apps: string[], current: LinkOpener) {
  const named = current.kind === 'app' && !apps.includes(current.app) ? [current.app] : []
  const item = (app: string) => ({
    value: `app:${app}`,
    label: named.includes(app) ? `${app} (not installed)` : app,
  })
  const all = [...named, ...apps]
  return [
    {
      group: 'Relay',
      items: [
        { value: 'browser', label: 'Relay browser' },
        { value: 'reviews', label: 'Relay Reviews' },
        { value: 'system', label: 'Default browser' },
      ],
    },
    { group: 'Browsers', items: all.filter((a) => BROWSERS.has(a)).map(item) },
    { group: 'Apps for links', items: all.filter((a) => LINK_APPS.has(a)).map(item) },
    { group: 'URL scheme', items: [{ value: 'scheme', label: 'Custom URL scheme' }] },
    {
      group: 'Other apps',
      items: all.filter((a) => !BROWSERS.has(a) && !LINK_APPS.has(a)).map(item),
    },
  ].filter((g) => g.items.length > 0)
}

function OpenerPicker({
  label,
  testid,
  opener,
  pattern,
  apps,
  onChange,
}: {
  label: string
  testid: string
  opener: LinkOpener
  pattern: string
  apps: string[]
  onChange: (o: LinkOpener) => void
}) {
  const [template, setTemplate] = useState(opener.kind === 'scheme' ? opener.template : '')
  useEffect(() => {
    if (opener.kind === 'scheme') setTemplate(opener.template)
  }, [opener])
  return (
    <div className="eva-links-opener">
      <Select
        size="sm"
        aria-label={label}
        data-testid={testid}
        searchable
        allowDeselect={false}
        value={openerValue(opener)}
        data={openerData(apps, opener)}
        onChange={(v) => v && onChange(openerOf(v, opener, pattern))}
      />
      {opener.kind === 'scheme' ? (
        <TextInput
          size="sm"
          aria-label={`${label} URL scheme`}
          data-testid={`${testid}-scheme`}
          value={template}
          placeholder="linear://{path}"
          error={
            /^[a-z][a-z0-9+.-]*:/i.test(template)
              ? undefined
              : 'Start with a scheme, like linear://'
          }
          onChange={(e) => setTemplate(e.currentTarget.value)}
          onBlur={() => {
            if (
              template !== opener.template &&
              /^[a-z][a-z0-9+.-]*:/i.test(template) &&
              template.length >= 3
            )
              onChange({ kind: 'scheme', template })
          }}
        />
      ) : null}
    </div>
  )
}

async function save(prefs: LinkPrefs): Promise<void> {
  const error = await saveLinkPrefs(prefs)
  if (error) notifications.show({ color: 'red', message: error })
}

export function LinksSection() {
  useEffect(() => {
    void startLinks()
  }, [])
  const prefs = useLinkPrefs((s) => s.prefs)
  const apps = useLinkPrefs((s) => s.apps)
  const [draft, setDraft] = useState('')
  const [draftError, setDraftError] = useState<string | null>(null)

  const setRule = (i: number, opener: LinkOpener) =>
    void save({ ...prefs, rules: prefs.rules.map((r, j) => (j === i ? { ...r, opener } : r)) })
  const remove = (i: number) =>
    void save({ ...prefs, rules: prefs.rules.filter((_, j) => j !== i) })
  const raise = (i: number) => {
    const rules = [...prefs.rules]
    ;[rules[i - 1], rules[i]] = [rules[i]!, rules[i - 1]!]
    void save({ ...prefs, rules })
  }
  const add = () => {
    const pattern = normalizePattern(draft)
    if (!pattern) {
      setDraftError('Type a site like example.com or *.example.com')
      return
    }
    if (prefs.rules.some((r) => r.pattern === pattern)) {
      setDraftError(`${pattern} already has a rule`)
      return
    }
    void save({ ...prefs, rules: [...prefs.rules, { pattern, opener: { kind: 'browser' } }] })
    setDraft('')
    setDraftError(null)
  }

  return (
    <>
      <div className="eva-settings-card" data-testid="links-rules">
        {prefs.rules.map((rule, i) => (
          <div
            key={rule.pattern}
            className="eva-settings-row eva-settings-row-static"
            data-testid={`links-rule-${rule.pattern}`}
          >
            <span className="eva-settings-label">
              <span className="eva-settings-label-title">{rule.pattern}</span>
              <span className="eva-settings-label-help">
                {rule.pattern.startsWith('*.')
                  ? `Any subdomain of ${rule.pattern.slice(2)}`
                  : rule.pattern.includes('/')
                    ? 'This page and the pages under it'
                    : `${rule.pattern} and www.${rule.pattern}`}
              </span>
            </span>
            <span className="eva-links-controls">
              <OpenerPicker
                label={`Open ${rule.pattern} in`}
                testid={`links-opener-${rule.pattern}`}
                opener={rule.opener}
                pattern={rule.pattern}
                apps={apps}
                onChange={(o) => setRule(i, o)}
              />
              <Tooltip label="Check before the rules above it">
                <ActionIcon
                  variant="subtle"
                  aria-label={`Move ${rule.pattern} up`}
                  disabled={i === 0}
                  onClick={() => raise(i)}
                >
                  <IconArrowUp size={16} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Remove">
                <ActionIcon
                  variant="subtle"
                  aria-label={`Remove ${rule.pattern}`}
                  data-testid={`links-remove-${rule.pattern}`}
                  onClick={() => remove(i)}
                >
                  <IconTrash size={16} />
                </ActionIcon>
              </Tooltip>
            </span>
          </div>
        ))}
        <div className="eva-settings-row eva-settings-row-static">
          <span className="eva-settings-label">
            <span className="eva-settings-label-title">Everything else</span>
            <span className="eva-settings-label-help">Links no rule above matches.</span>
          </span>
          <span className="eva-links-controls">
            <OpenerPicker
              label="Open other links in"
              testid="links-opener-fallback"
              opener={prefs.fallback}
              pattern=""
              apps={apps}
              onChange={(fallback) => void save({ ...prefs, fallback })}
            />
          </span>
        </div>
      </div>
      <form
        className="eva-links-add"
        onSubmit={(e) => {
          e.preventDefault()
          add()
        }}
      >
        <TextInput
          size="sm"
          className="eva-links-add-input"
          aria-label="Site"
          data-testid="links-add-input"
          placeholder="example.com, *.example.com or example.com/docs"
          value={draft}
          error={draftError}
          onChange={(e) => {
            setDraft(e.currentTarget.value)
            setDraftError(null)
          }}
        />
        <Button size="sm" type="submit" data-testid="links-add">
          Add site
        </Button>
        <Button
          size="sm"
          variant="subtle"
          data-testid="links-reset"
          onClick={() => void save(DEFAULT_LINK_PREFS)}
        >
          Restore defaults
        </Button>
      </form>
      <p className="eva-settings-desc">
        Rules are checked top to bottom. An app that isn&apos;t installed opens the link in
        Relay&apos;s browser. In a URL scheme, {'{url}'} is the whole link, {'{host}'} its site and{' '}
        {'{path}'} what follows the site.
      </p>
    </>
  )
}

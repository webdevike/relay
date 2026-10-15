import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  ActionIcon, Alert, Autocomplete, Badge, Button, Checkbox, ColorPicker, Indicator,
  Radio, SegmentedControl, Slider, Switch, Tabs, TextInput, Progress,
} from '@mantine/core'
import {
  IconAlertTriangle, IconBold, IconCheck, IconChevronDown, IconChevronRight,
  IconCircleCheck, IconCircleX, IconCopy, IconInfoCircle, IconItalic,
  IconArrowForwardUp, IconRotateClockwise, IconSearch, IconArrowBackUp,
} from '@tabler/icons-react'
import {
  COLOR_KEYS, HIGHLIGHT_COLOR_KEYS, SYNTAX_TOKEN_KEYS, getThemePreset, resolveTheme,
  exportTheme, type ColorKey, type ModeEdits, type SharedEdits, type SyntaxStyle, type ThemeDoc,
} from '@evaos/theme-core'
import { invoke } from '../ipc'
import { saveThemeDoc, setAppearance, setThemeBase, themeStore, useTheme } from '../theme/theme-store'
import { ScrollArea } from '../ui/ScrollArea'
import { EvaMenu } from '../overlay/EvaMenu'
import { EvaPopover } from '../overlay/EvaPopover'

type Section = 'Colors' | 'Typography' | 'Syntax' | 'Other' | 'Export'
type Mode = 'light' | 'dark'
const SECTIONS: Section[] = ['Colors', 'Typography', 'Syntax', 'Other', 'Export']
const COLOR_GROUPS: [string, string[]][] = [
  ['Base', ['background', 'foreground', 'border', 'input', 'ring', 'selection', 'caret', 'overlay', 'window', 'drag', 'drop_target']],
  ['Primary', ['primary']], ['Secondary', ['secondary']], ['Accent and muted', ['accent', 'muted']],
  ['Status', ['danger', 'success', 'warning', 'info']], ['Buttons', ['button']], ['Popover', ['popover']],
  ['Sidebar', ['sidebar']], ['Tabs', ['tab', 'tab_bar']], ['Lists', ['list']], ['Tables', ['table']],
  ['Title and status bars', ['title_bar', 'status_bar']], ['Scrollbar', ['scrollbar']],
  ['Controls', ['slider', 'switch', 'progress', 'skeleton', 'accordion']],
  ['Content', ['link', 'description_list', 'group_box']], ['Charts', ['chart']], ['Palette', ['base']],
]
const FONT_FAMILIES = ['Berkeley Mono', 'SF Pro Text', 'SF Mono', 'Arial', 'Helvetica', 'Georgia', 'Menlo', 'Monaco', 'Courier New', 'system-ui', 'monospace']

function Swatches({ family, mode }: { family: string; mode: Mode }) {
  const colors = getThemePreset(family, mode)?.colors
  return <span className="eva-theme-swatches" aria-hidden="true">
    {(['primary.background', 'background', 'border', 'foreground'] as const).map((key) =>
      <span key={key} style={{ backgroundColor: colors?.[key] ?? 'var(--eva-border)' }} />)}
  </span>
}

function NumericProperty({ label, value, min, max, disabled, onChange }: {
  label: string; value: number; min: number; max: number; disabled: boolean; onChange: (value: number) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return <div className="eva-theme-number">
    <Slider aria-label={label} thumbLabel={label} value={draft} min={min} max={max} step={1} disabled={disabled}
      onChange={setDraft} onChangeEnd={onChange} size="xs" />
    <output>{draft}px</output>
  </div>
}

function FontProperty({ label, value, disabled, onChange }: {
  label: string; value: string; disabled: boolean; onChange: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => { if (draft.trim() && draft.trim() !== value) onChange(draft.trim()) }
  return <Autocomplete aria-label={label} value={draft} data={FONT_FAMILIES} size="xs"
    disabled={disabled} onChange={setDraft} onBlur={commit}
    onOptionSubmit={onChange} onKeyDown={(event) => { if (event.key === 'Enter') commit() }} />
}

function ColorProperty({ name, value, disabled, onChange }: {
  name: string; value: string; disabled: boolean; onChange: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const [pickerOpened, setPickerOpened] = useState(false)
  useEffect(() => setDraft(value), [value])
  const changeColor = (next: string) => {
    setDraft(next)
    const hex = next.startsWith('#') ? next : `#${next}`
    if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) onChange(hex)
  }
  return <div className="eva-theme-color">
    <EvaPopover opened={pickerOpened} onChange={setPickerOpened} position="bottom-start">
      <EvaPopover.Target>
        <button type="button" className="eva-theme-color-swatch" aria-label={`Pick ${name} color`}
          disabled={disabled} aria-expanded={pickerOpened} onClick={() => setPickerOpened((opened) => !opened)} style={{ backgroundColor: value }} />
      </EvaPopover.Target>
      <EvaPopover.Dropdown><ColorPicker value={value} format="hexa" onChange={changeColor} /></EvaPopover.Dropdown>
    </EvaPopover>
    <TextInput aria-label={name} size="xs" variant="unstyled" value={draft} disabled={disabled}
      onChange={(event) => changeColor(event.currentTarget.value)} onBlur={() => setDraft(value)} />
  </div>
}

interface Property {
  section: Section
  group: string
  key: string
  label: string
  edited: boolean
  control: ReactNode
  reset: () => void
}

export function ThemeSection() {
  const doc = useTheme((s) => s.doc)
  const mode = useTheme((s) => s.resolved)
  const baseSaving = useTheme((s) => s.baseSaving)
  const saving = useTheme((s) => s.baseSaving || s.docSaving)
  const saveError = useTheme((s) => s.baseError ?? s.docError)
  const [themes, setThemes] = useState<{ id: string; name: string }[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [section, setSection] = useState<Section>('Colors')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(new Set(['Base', 'Interface font', 'Code font', 'Shape', 'Tokens']))
  const [undo, setUndo] = useState<ThemeDoc[]>([])
  const [redo, setRedo] = useState<ThemeDoc[]>([])
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [familyOpened, setFamilyOpened] = useState(false)
  const lastEdit = useRef<{ key: string; at: number } | null>(null)
  const copyTimer = useRef<number | undefined>(undefined)
  const pending = useRef(false)
  const resolved = resolveTheme(doc, mode)
  useEffect(() => {
    let live = true
    void invoke('theme.list', {}).then((result) => {
      if (!live) return
      if (result.ok) setThemes(result.value.themes)
      else setLoadError('Could not load theme families.')
    }).catch(() => { if (live) setLoadError('Could not load theme families.') })
    return () => { live = false; window.clearTimeout(copyTimer.current) }
  }, [])

  async function commit(next: ThemeDoc, key: string) {
    const previous = themeStore.getState().doc
    if (JSON.stringify(next) === JSON.stringify(previous)) return
    try {
      await saveThemeDoc(next)
      const now = Date.now()
      if (lastEdit.current?.key !== key || now - lastEdit.current.at > 1200) setUndo((items) => [...items, previous])
      lastEdit.current = { key, at: now }
      setRedo([])
    } catch { /* The store restores the document and exposes the persistence error. */ }
  }

  async function history(direction: 'undo' | 'redo') {
    const source = direction === 'undo' ? undo : redo
    const next = source.at(-1)
    if (!next || pending.current || saving) return
    const previous = themeStore.getState().doc
    pending.current = true
    try {
      await saveThemeDoc(next)
      if (direction === 'undo') { setUndo(source.slice(0, -1)); setRedo((items) => [...items, previous]) }
      else { setRedo(source.slice(0, -1)); setUndo((items) => [...items, previous]) }
      lastEdit.current = null
    } catch { /* Keep history intact when persistence fails. */ }
    finally { pending.current = false }
  }

  async function pickFamily(base: string) {
    if (pending.current || base === doc.base) return
    const previous = themeStore.getState().doc
    pending.current = true
    try {
      await setThemeBase(base)
      if (themeStore.getState().doc.base !== previous.base) {
        setUndo((items) => [...items, previous]); setRedo([]); lastEdit.current = null
      }
    } finally { pending.current = false }
  }

  function colorEdit(key: ColorKey, value?: string) {
    const edits = { ...doc[mode].edits }
    if (value === undefined) delete edits[key]
    else edits[key] = value
    void commit({ ...doc, [mode]: { ...doc[mode], edits } }, `color:${mode}:${key}`)
  }
  function sharedEdit(key: keyof SharedEdits, value?: string | number | boolean) {
    const shared = { ...doc.shared }
    if (value === undefined) delete shared[key]
    else Object.assign(shared, { [key]: value })
    void commit({ ...doc, shared }, `shared:${key}`)
  }
  function highlightEdit(key: string, value?: string | SyntaxStyle) {
    const highlight = { ...doc[mode].edits.highlight }
    if (key.startsWith('syntax.')) {
      const token = key.slice(7)
      const syntax = { ...highlight.syntax }
      if (value === undefined) delete syntax[token]
      else syntax[token] = value as SyntaxStyle
      highlight.syntax = syntax
    } else if (value === undefined) delete highlight[key]
    else Object.assign(highlight, { [key]: value })
    const edits: ModeEdits = { ...doc[mode].edits, highlight }
    if (!Object.keys(highlight.syntax ?? {}).length) delete highlight.syntax
    if (!Object.keys(highlight).length) delete edits.highlight
    void commit({ ...doc, [mode]: { ...doc[mode], edits } }, `highlight:${mode}:${key}`)
  }

  const properties: Property[] = COLOR_GROUPS.flatMap(([group, heads]) =>
    COLOR_KEYS.filter((key) => heads.includes(key.split('.')[0]!)).map((key) => ({
      section: 'Colors' as const, group, key,
      label: heads.length === 1 ? key.replace(`${heads[0]}.`, '') : key,
      edited: doc[mode].edits[key] !== undefined,
      control: <ColorProperty name={key} value={resolved.colors[key]} disabled={baseSaving} onChange={(value) => colorEdit(key, value)} />,
      reset: () => colorEdit(key),
    })))
  for (const mono of [false, true]) {
    const group = mono ? 'Code font' : 'Interface font'
    const prefix = mono ? 'mono_font' : 'font'
    const font = mono ? resolved.monoFont : resolved.font
    const familyKey = `${prefix}.family` as keyof SharedEdits
    const sizeKey = `${prefix}.size` as keyof SharedEdits
    properties.push({ section: 'Typography', group, key: familyKey, label: 'family', edited: doc.shared[familyKey] !== undefined,
      control: <FontProperty label={mono ? 'Code font family' : 'Font family'} value={font.family} disabled={baseSaving} onChange={(value) => sharedEdit(familyKey, value)} />,
      reset: () => sharedEdit(familyKey) })
    properties.push({ section: 'Typography', group, key: sizeKey, label: 'size', edited: doc.shared[sizeKey] !== undefined,
      control: <NumericProperty label={mono ? 'Code font size' : 'Font size'} value={font.size} min={mono ? 9 : 10} max={24} disabled={baseSaving} onChange={(value) => sharedEdit(sizeKey, value)} />,
      reset: () => sharedEdit(sizeKey) })
  }
  for (const key of HIGHLIGHT_COLOR_KEYS) properties.push({ section: 'Syntax', group: key.startsWith('editor.') ? 'Editor' : 'Diagnostics', key: `highlight.${key}`,
    label: key.replace(/^editor\./, ''), edited: doc[mode].edits.highlight?.[key] !== undefined,
    control: <ColorProperty name={`highlight.${key}`} value={resolved.highlight[key]} disabled={baseSaving} onChange={(value) => highlightEdit(key, value)} />,
    reset: () => highlightEdit(key) })
  for (const token of SYNTAX_TOKEN_KEYS) {
    const style = resolved.highlight.syntax[token] ?? {}
    const edited = doc[mode].edits.highlight?.syntax?.[token]
    const update = (patch: SyntaxStyle) => highlightEdit(`syntax.${token}`, { ...edited, ...patch })
    properties.push({ section: 'Syntax', group: 'Tokens', key: `highlight.syntax.${token}`, label: token, edited: edited !== undefined,
      control: <div className="eva-theme-syntax-control">
        <ColorProperty name={`Syntax ${token} color`} value={style.color ?? resolved.colors.foreground} disabled={baseSaving} onChange={(color) => update({ color })} />
        <ActionIcon size="xs" variant={style.font_style === 'italic' ? 'filled' : 'subtle'} aria-label={`Italic ${token}`} aria-pressed={style.font_style === 'italic'} disabled={baseSaving}
          onClick={() => update({ font_style: style.font_style === 'italic' ? 'normal' : 'italic' })}><IconItalic size={12} /></ActionIcon>
        <ActionIcon size="xs" variant={(style.font_weight ?? 400) >= 600 ? 'filled' : 'subtle'} aria-label={`Bold ${token}`} aria-pressed={(style.font_weight ?? 400) >= 600} disabled={baseSaving}
          onClick={() => update({ font_weight: (style.font_weight ?? 400) >= 600 ? 400 : 700 })}><IconBold size={12} /></ActionIcon>
      </div>, reset: () => highlightEdit(`syntax.${token}`) })
  }
  for (const [key, label, value, max] of [
    ['radius', 'radius', resolved.radius, 24], ['radius.lg', 'radius.lg', resolved.radiusLg, 32],
  ] as const) properties.push({ section: 'Other', group: 'Shape', key, label, edited: doc.shared[key] !== undefined,
    control: <NumericProperty label={label} value={value} min={0} max={max} disabled={baseSaving} onChange={(next) => sharedEdit(key, next)} />, reset: () => sharedEdit(key) })
  properties.push({ section: 'Other', group: 'Shape', key: 'shadow', label: 'shadow', edited: doc.shared.shadow !== undefined,
    control: <Switch aria-label="Control shadows" checked={resolved.shadow} disabled={baseSaving} onChange={(event) => sharedEdit('shadow', event.currentTarget.checked)} size="xs" />,
    reset: () => sharedEdit('shadow') })

  const search = query.trim().toLowerCase()
  const visible = properties.filter((property) => search ? `${property.section} ${property.group} ${property.key} ${property.label}`.toLowerCase().includes(search) : property.section === section)
  const groups = [...new Set(visible.map((property) => `${property.section}/${property.group}`))]
  const exported = JSON.stringify(exportTheme(doc), null, 2)
  const modeName = mode === 'dark' ? 'Dark' : 'Light'
  return <div className="eva-theme-editor" data-testid="theme-editor">
    <aside className="eva-theme-tools" aria-label="Theme properties">
      <header className="eva-theme-header">
        <div className="eva-theme-mode-row">
          <SegmentedControl aria-label="Edit appearance" value={mode} data={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]}
            onClickCapture={(event) => {
              // Selecting the already-resolved mode must also leave System appearance.
              const target = event.target
              if (target instanceof HTMLInputElement && target.value === mode && themeStore.getState().appearance === 'system') {
                lastEdit.current = null
                setAppearance(mode)
              }
            }}
            onChange={(value) => { lastEdit.current = null; setAppearance(value as Mode) }} size="xs" disabled={saving} />
          <div className="eva-theme-history">
            <ActionIcon variant="subtle" aria-label="Undo" title="Undo" disabled={!undo.length || saving} onClick={() => void history('undo')}><IconArrowBackUp size={14} /></ActionIcon>
            <ActionIcon variant="subtle" aria-label="Redo" title="Redo" disabled={!redo.length || saving} onClick={() => void history('redo')}><IconArrowForwardUp size={14} /></ActionIcon>
          </div>
        </div>
        <div className="eva-theme-preset-row"><span className="eva-theme-preset-label">Start from</span>
          <EvaMenu opened={familyOpened} onChange={setFamilyOpened} width={300} position="bottom-start">
            <EvaMenu.Target><Button variant="outline" size="sm" data-testid="theme-family-picker" aria-label="Theme family" aria-busy={saving}
              disabled={themes === null || saving || loadError !== null} title="Theme for both Light and Dark">
              <span className="eva-theme-preset-content"><Swatches family={doc.base} mode={mode} />{doc.base}<IconChevronDown size={11} /></span>
            </Button></EvaMenu.Target>
            <EvaMenu.Dropdown style={{ maxHeight: 460, overflowY: 'auto' }}>
              {(themes ?? []).map(({ id, name }, index) => <div key={id}>
                {index === 1 ? <><EvaMenu.Divider /><EvaMenu.Label>gpui-kit themes</EvaMenu.Label></> : null}
                <EvaMenu.Item onClick={() => void pickFamily(id)} leftSection={<Swatches family={id} mode={mode} />}
                  rightSection={id === doc.base ? <IconCheck size={14} aria-label="Selected" /> : null}>{name}</EvaMenu.Item>
              </div>)}
            </EvaMenu.Dropdown>
          </EvaMenu>
        </div>
        <div className="eva-theme-sections" role="tablist" aria-label="Theme sections">
          {SECTIONS.map((name) => <Button key={name} role="tab" aria-selected={section === name} aria-controls="theme-properties"
            variant={section === name ? 'filled' : 'subtle'} size="xs" onClick={() => { setSection(name); if (name === 'Export') setQuery('') }}>{name}</Button>)}
        </div>
        {section !== 'Export' ? <TextInput data-testid="theme-property-search" aria-label="Search properties" placeholder="Search properties..." size="sm"
          leftSection={<IconSearch size={12} />} value={query} onChange={(event) => setQuery(event.currentTarget.value)} /> : null}
      </header>
      <ScrollArea className="eva-theme-controls-scroll" scrollKey="theme-controls" fadeBg="var(--eva-theme-tools-bg)">
        <div id="theme-properties" className="eva-theme-properties" role="tabpanel" aria-label={`${section} properties`}>
          {section === 'Export' && !search ? <div className="eva-theme-export">
            <p>Both themes as one gpui-kit theme file, every layer applied. Drop it in any gpui-kit app's themes folder.</p>
            <Button size="sm" leftSection={<IconCopy size={14} />} onClick={() => {
              void navigator.clipboard.writeText(exported).then(() => {
                setCopied(true); setCopyError(null)
                window.clearTimeout(copyTimer.current)
                copyTimer.current = window.setTimeout(() => setCopied(false), 2000)
              }).catch(() => setCopyError('Could not copy JSON. Select and copy the document below.'))
            }}>{copied ? 'Copied' : 'Copy JSON'}</Button>
            {copyError ? <p role="alert">{copyError}</p> : null}
            <pre aria-label="Theme JSON" tabIndex={0}>{exported}</pre>
          </div> : groups.length ? groups.map((id) => {
            const rows = visible.filter((property) => `${property.section}/${property.group}` === id)
            const group = rows[0]!.group
            const expanded = Boolean(search) || open.has(group)
            const edited = rows.filter((property) => property.edited).length
            return <section className="eva-theme-group" key={id}>
              <button className="eva-theme-group-heading" aria-expanded={expanded} onClick={() => setOpen((previous) => {
                const next = new Set(previous); if (next.has(group)) next.delete(group); else next.add(group); return next
              })}>{expanded ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
                {search && rows[0]!.section !== section ? `${rows[0]!.section} / ` : ''}{group}<span>{edited ? `${edited} edited` : ''}</span>
              </button>
              {expanded ? rows.map((property) => <div className="eva-theme-property" key={property.key} data-edited={property.edited}>
                <span className="eva-theme-property-label" title={property.key}>{property.label}</span>
                <div className="eva-theme-property-control">{property.control}</div>
                <ActionIcon className="eva-theme-property-reset" size="xs" variant="subtle" aria-label={`Reset ${property.key}`} title="Reset property"
                  disabled={!property.edited || saving} onClick={property.reset}><IconRotateClockwise size={11} /></ActionIcon>
              </div>) : null}
            </section>
          }) : <p className="eva-theme-empty">No properties match “{query}”.</p>}
        </div>
      </ScrollArea>
      <footer className="eva-theme-footer">
        <div className="eva-theme-reset-row">
          <Button variant="outline" size="sm" leftSection={<IconRotateClockwise size={12} />} disabled={saving || !Object.keys(doc[mode].edits).length}
            onClick={() => void commit({ ...doc, [mode]: { ...doc[mode], edits: {} } }, `reset:${mode}`)}>Reset {modeName}</Button>
          <Button variant="outline" size="sm" disabled={saving || !Object.keys(doc.shared).length}
            onClick={() => void commit({ ...doc, shared: {} }, 'reset:shared')}>Reset shared edits</Button>
        </div>
        {(loadError ?? saveError) ? <p role="alert" className="eva-control-error">{loadError ?? saveError}</p>
          : <p role="status">{saving ? 'Saving theme...' : 'Edits save automatically to theme.json.'}</p>}
      </footer>
    </aside>
    <ThemePreview doc={doc} mode={mode} />
  </div>
}

function PreviewPanel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="eva-theme-preview-card" aria-label={title}><h3>{title}</h3>{children}</section>
}

function ThemePreview({ doc, mode }: { doc: ThemeDoc; mode: Mode }) {
  const [input, setInput] = useState('')
  const [checked, setChecked] = useState(true)
  const [switched, setSwitched] = useState(true)
  const [radio, setRadio] = useState('radio')
  const [slider, setSlider] = useState(40)
  const [tab, setTab] = useState('0')
  const [menuStatus, setMenuStatus] = useState('')
  const [menuOpened, setMenuOpened] = useState(false)
  const resolved = resolveTheme(doc, mode)
  const token = (name: string): CSSProperties => {
    const style = resolved.highlight.syntax[name]
    return { color: style?.color, fontWeight: style?.font_weight, fontStyle: style?.font_style }
  }
  const tone = (name: string): CSSProperties => ({
    '--preview-tone': `var(--eva-c-${name}-background)`, '--preview-tone-text': `var(--eva-c-${name}-foreground)`,
  } as CSSProperties)
  const buttons = <PreviewPanel title="Buttons"><div className="eva-theme-sample-row">
    <Button>Primary</Button><Button variant="default">Default</Button><Button variant="outline">Outline</Button><Button variant="subtle">Ghost</Button>
    <Button color="red">Danger</Button><Button color="green">Success</Button><Button color="yellow">Warning</Button><Button color="blue">Info</Button>
    <Button variant="transparent" className="eva-theme-link">Link</Button><Button variant="default" disabled>Disabled</Button>
  </div></PreviewPanel>
  const controls = <PreviewPanel title="Controls">
    <TextInput placeholder="Type to preview" aria-label="Preview text" value={input} onChange={(event) => setInput(event.currentTarget.value)} />
    <div className="eva-theme-sample-row eva-theme-sample-controls">
      <Switch label="Switch" checked={switched} onChange={(event) => setSwitched(event.currentTarget.checked)} size="xs" />
      <Checkbox label="Checkbox" checked={checked} onChange={(event) => setChecked(event.currentTarget.checked)} size="xs" />
      <Radio.Group value={radio} onChange={setRadio}><div className="eva-theme-sample-row"><Radio label="Radio" value="radio" size="xs" /><Radio label="Other" value="other" size="xs" /></div></Radio.Group>
    </div><Slider aria-label="Preview slider" thumbLabel="Preview slider" value={slider} onChange={setSlider} size="xs" /><Progress value={64} size="sm" />
  </PreviewPanel>
  const tabs = <PreviewPanel title="Tabs and tags">
    <Tabs value={tab} onChange={(value) => setTab(value ?? '0')}><Tabs.List>{['Overview', 'Activity', 'Settings'].map((name, index) => <Tabs.Tab key={name} value={String(index)}>{name}</Tabs.Tab>)}</Tabs.List></Tabs>
    <SegmentedControl aria-label="Preview period" value={tab} onChange={setTab} data={['Day', 'Week', 'Month'].map((label, index) => ({ label, value: String(index) }))} fullWidth size="xs" />
    <div className="eva-theme-sample-row">{['primary', 'secondary', 'success', 'warning', 'danger', 'info'].map((name) =>
      <Badge key={name} variant="filled" className="eva-theme-sample-tag" style={tone(name)}>{name}</Badge>)}
      <Indicator label="3" size={13} color="red"><Button size="sm" variant="default">Inbox</Button></Indicator>
    </div>
  </PreviewPanel>
  const alerts = <PreviewPanel title="Alerts">{[
    ['info', 'Info: the theme saves as you edit.', IconInfoCircle], ['success', 'Success: two themes, one file.', IconCircleCheck],
    ['warning', 'Warning: low contrast is easy to miss.', IconAlertTriangle], ['danger', 'Error: something needs attention.', IconCircleX],
  ].map(([name, message, Icon]) => {
    const AlertIcon = Icon as typeof IconInfoCircle
    return <Alert key={String(name)} role="note" icon={<AlertIcon size={13} />} className="eva-theme-sample-alert" style={tone(String(name))}>{String(message)}</Alert>
  })}</PreviewPanel>
  const chart = <PreviewPanel title="Chart colors"><div className="eva-theme-sample-chart" role="img" aria-label="Ten bars using the five theme chart colors">
    {[44, 72, 58, 90, 36, 64, 80, 50, 68, 40].map((height, index) => <div key={index} style={{ height, background: `var(--eva-c-chart-${index % 5 + 1})` }} />)}
  </div></PreviewPanel>
  const text = <PreviewPanel title="Text and code"><div className="eva-theme-sample-text">
    <h2>Weekly note</h2><p>The <strong>dashboard</strong> reads <code>memory/journal.md</code> and shows <a href="https://example.com" onClick={(event) => event.preventDefault()}>links</a> like this. Muted text and code use the fonts above.</p>
    <pre style={{ backgroundColor: resolved.highlight['editor.background'], color: resolved.highlight['editor.foreground'] }}><code>
      <span style={token('comment')}>{'// Syntax colors come from the Syntax tab.'}</span>{'\n'}
      <span style={token('keyword')}>fn</span>{' '}<span style={token('function')}>greet</span>{'('}<span style={token('variable')}>name</span>{': &'}<span style={token('type')}>str</span>{') -> '}<span style={token('type')}>String</span>{' {\n    '}
      <span style={token('keyword')}>let</span>{' count = '}<span style={token('number')}>3</span>{';\n    '}<span style={token('function')}>format!</span>{'('}<span style={token('string')}>{'"hi {name}, {count} todos"'}</span>{')\n}'}
    </code></pre>
  </div></PreviewPanel>
  const menu = <PreviewPanel title="Popover and menu"><div className="eva-theme-sample-row">
    <EvaMenu opened={menuOpened} onChange={setMenuOpened}>
      <EvaMenu.Target><Button variant="outline" rightSection={<IconChevronDown size={13} />}>Open menu</Button></EvaMenu.Target>
      <EvaMenu.Dropdown><EvaMenu.Item onClick={() => setMenuStatus('Rename selected')}>Rename</EvaMenu.Item>
        <EvaMenu.Item rightSection={<IconCheck size={12} />} onClick={() => setMenuStatus('Duplicate selected')}>Duplicate</EvaMenu.Item><EvaMenu.Divider />
        <EvaMenu.Item onClick={() => setMenuStatus('Delete selected')}>Delete</EvaMenu.Item></EvaMenu.Dropdown>
    </EvaMenu>{menuStatus ? <span role="status">{menuStatus}</span> : null}
  </div></PreviewPanel>
  return <ScrollArea className="eva-theme-preview-scroll" scrollKey="theme-preview" data-testid="theme-preview">
    <div className="eva-theme-preview"><div className="eva-theme-preview-heading"><h2>Preview</h2><p>Real components, drawn with the theme you're editing.</p></div>
      <div className="eva-theme-preview-grid"><div className="eva-theme-preview-column">{buttons}{controls}{tabs}</div><div className="eva-theme-preview-column">{alerts}{chart}{text}{menu}</div></div>
    </div>
  </ScrollArea>
}

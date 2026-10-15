import { StrictMode, useEffect, useRef } from 'react'
import { act, render } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultDoc, parseThemeDoc, resolveTheme } from '@evaos/theme-core'

const invoke = vi.fn()
const show = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
vi.mock('@mantine/notifications', () => ({
  notifications: { show: (...a: unknown[]) => show(...a) },
}))

import { applyTheme, reportBackground } from './applier'
import { createStaticColorSchemeManager } from './color-scheme-manager'
import {
  disposeThemeListeners,
  initTheme,
  setAppearance,
  setThemeBase,
  saveThemeDoc,
  themeStore,
} from './theme-store'
import { ThemeBridge } from './ThemeBridge'
import { bootstrapTheme } from './bootstrap'

type Listener = () => void
let dark = true
const listeners = new Set<Listener>()

function installMatchMedia(): void {
  window.matchMedia = ((q: string) => ({
    get matches() {
      return q.includes('dark') ? dark : false
    },
    media: q,
    addEventListener: (_: string, l: Listener) => listeners.add(l),
    removeEventListener: (_: string, l: Listener) => listeners.delete(l),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  })) as unknown as typeof window.matchMedia
}

function recordingRoot() {
  const props = new Map<string, string>()
  const root = {
    style: {
      setProperty: (k: string, v: string) => props.set(k, v),
      colorScheme: '',
    },
    dataset: {} as Record<string, string>,
    setAttribute: () => {},
  } as unknown as HTMLElement
  return { root, props }
}

beforeEach(() => {
  invoke.mockReset()
  invoke.mockResolvedValue({ ok: true, value: {} })
  show.mockReset()
  disposeThemeListeners()
  listeners.clear()
  dark = true
  installMatchMedia()
})

describe('applyTheme', () => {
  it('writes 139 color properties and 7 shape properties', () => {
    const { root, props } = recordingRoot()
    applyTheme(root, resolveTheme(defaultDoc(), 'dark'))
    const colors = [...props.keys()].filter((k) => k.startsWith('--eva-c-'))
    expect(colors).toHaveLength(139)
    expect(props.size).toBe(146)
  })

  it('keeps the same names across modes and changes values', () => {
    const a = recordingRoot()
    const b = recordingRoot()
    applyTheme(a.root, resolveTheme(defaultDoc(), 'light'))
    applyTheme(b.root, resolveTheme(defaultDoc(), 'dark'))
    expect([...a.props.keys()].sort()).toEqual([...b.props.keys()].sort())
  })

  it('reports a 6-digit background, stripping alpha', () => {
    const resolved = resolveTheme(defaultDoc(), 'dark')
    resolved.colors['sidebar.background'] = '#11223344'
    reportBackground(resolved)
    expect(invoke).toHaveBeenCalledWith('app.setBackground', { color: '#112233' })
  })
})

describe('theme store', () => {
  it('system follows matchMedia live; explicit appearance ignores it', () => {
    initTheme('system')
    expect(document.documentElement.dataset['resolved']).toBe('dark')
    dark = false
    act(() => listeners.forEach((l) => l()))
    expect(document.documentElement.dataset['resolved']).toBe('light')
    setAppearance('dark')
    dark = false
    act(() => listeners.forEach((l) => l()))
    expect(document.documentElement.dataset['resolved']).toBe('dark')
  })

  it('every apply reports the sidebar background', () => {
    initTheme('light')
    const calls = invoke.mock.calls.filter((c) => c[0] === 'app.setBackground')
    expect(calls).toHaveLength(1)
    expect((calls[0]![1] as { color: string }).color).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('setAppearance persists once and updates html attributes', () => {
    initTheme('light')
    invoke.mockClear()
    setAppearance('dark')
    expect(invoke.mock.calls.filter((c) => c[0] === 'theme.setAppearance')).toHaveLength(1)
    expect(document.documentElement.dataset['appearance']).toBe('dark')
    expect(document.documentElement.dataset['resolved']).toBe('dark')
  })

  it('a failed save keeps the live theme and notifies', async () => {
    initTheme('light')
    invoke.mockImplementation((ch: string) =>
      ch === 'theme.setAppearance' ? Promise.reject(new Error('x')) : Promise.resolve({ ok: true }),
    )
    setAppearance('dark')
    await vi.waitFor(() => expect(show).toHaveBeenCalled())
    expect(document.documentElement.dataset['resolved']).toBe('dark')
    expect(show.mock.calls[0]![0].message).toBe(
      'Could not save your settings. Check that the EvaOS config folder is writable, then try again.',
    )
  })

  it('previews a family immediately and saves without replacing edits or appearance', async () => {
    const doc = parseThemeDoc({
      base: 'EvaOS',
      shared: { foreground: '#123456' },
      dark: { edits: { background: '#234567' }, unknown: true },
      light: { edits: { background: '#345678' } },
      app: { appearance: 'system', unknown: true },
      future: { enabled: true },
    })
    initTheme('system', doc)
    let finish!: (result: { ok: true; value: object }) => void
    const save = new Promise<{ ok: true; value: object }>((resolve) => {
      finish = resolve
    })
    invoke.mockImplementation((channel: string) =>
      channel === 'theme.setBase' ? save : Promise.resolve({ ok: true, value: {} }),
    )
    const pending = setThemeBase('Flexoki')
    expect(themeStore.getState().baseSaving).toBe(true)
    expect(themeStore.getState().doc.base).toBe('Flexoki')
    expect(document.documentElement.style.getPropertyValue('--eva-c-border')).toBe(
      resolveTheme({ ...doc, base: 'Flexoki' }, 'dark').colors.border,
    )
    expect(document.documentElement.style.getPropertyValue('--eva-c-foreground')).toBe('#123456')
    expect(document.documentElement.style.getPropertyValue('--eva-c-background')).toBe('#234567')
    await setThemeBase('EvaOS')
    expect(invoke.mock.calls.filter(([channel]) => channel === 'theme.setBase')).toHaveLength(1)
    setAppearance('light')
    finish({ ok: true, value: {} })
    await pending
    expect(themeStore.getState().baseSaving).toBe(false)
    expect(themeStore.getState().appearance).toBe('light')
    expect(themeStore.getState().doc).toEqual({
      ...doc,
      base: 'Flexoki',
      app: { appearance: 'light' },
    })
    expect(themeStore.getState().doc.raw).toBe(doc.raw)
    expect(document.documentElement.style.getPropertyValue('--eva-c-background')).toBe('#345678')
  })

  it.each(['result', 'rejection'])(
    'restores only the base after a failed %s save',
    async (failure) => {
      const doc = parseThemeDoc({ base: 'EvaOS', shared: { foreground: '#123456' } })
      initTheme('dark', doc)
      invoke.mockImplementation((channel: string) => {
        if (channel !== 'theme.setBase') return Promise.resolve({ ok: true, value: {} })
        return failure === 'rejection'
          ? Promise.reject(new Error('read only'))
          : Promise.resolve({ ok: false, error: { code: 'IO', message: 'read only' } })
      })
      const pending = setThemeBase('Flexoki')
      setAppearance('light')
      await pending
      expect(themeStore.getState().doc.base).toBe('EvaOS')
      expect(themeStore.getState().doc.shared).toEqual(doc.shared)
      expect(themeStore.getState().appearance).toBe('light')
      expect(themeStore.getState().baseSaving).toBe(false)
      expect(themeStore.getState().baseError).toContain('previous theme has been restored')
      expect(document.documentElement.style.getPropertyValue('--eva-c-background')).toBe(
        resolveTheme(doc, 'light').colors.background,
      )
    },
  )

  it('applies and saves a complete native document including shared shape and syntax', async () => {
    initTheme('dark')
    const doc = parseThemeDoc({
      base: 'Flexoki', shared: { 'font.family': 'Inter', 'font.size': 18, 'mono_font.size': 15, radius: 4, 'radius.lg': 20, shadow: true },
      light: { edits: {} },
      dark: { edits: { highlight: { syntax: { keyword: { color: '#112233', font_style: 'italic', font_weight: 700 } } } } },
      app: { appearance: 'dark' }, future: true,
    })
    const saving = saveThemeDoc(doc)
    expect(themeStore.getState().doc).toBe(doc)
    expect(themeStore.getState().docSaving).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--eva-font-size')).toBe('18px')
    expect(document.documentElement.style.getPropertyValue('--eva-radius')).toBe('4px')
    await saving
    expect(themeStore.getState().docSaving).toBe(false)
    expect(invoke).toHaveBeenCalledWith('theme.saveDoc', { doc: expect.objectContaining({ future: true, shared: expect.objectContaining({ 'font.size': 18 }) }) })
  })

  it.each(['result', 'rejection'])('rolls back complete edits after a %s failure, retaining later appearance', async (failure) => {
    const original = parseThemeDoc({ shared: { 'font.size': 14 }, app: { appearance: 'dark' } })
    initTheme('dark', original)
    invoke.mockImplementation((channel: string) => {
      if (channel !== 'theme.saveDoc') return Promise.resolve({ ok: true, value: {} })
      return failure === 'rejection' ? Promise.reject(new Error('read only')) : Promise.resolve({ ok: false, error: { code: 'IO', message: 'read only' } })
    })
    const next = { ...original, shared: { 'font.size': 20 }, dark: { edits: { ring: '#123456' } } }
    const saving = saveThemeDoc(next)
    setAppearance('light')
    await expect(saving).rejects.toMatchObject({ message: 'read only' })
    expect(themeStore.getState().appearance).toBe('light')
    expect(themeStore.getState().doc.shared).toEqual(original.shared)
    expect(themeStore.getState().doc.dark).toEqual(original.dark)
    expect(themeStore.getState().docError).toContain('previous theme has been restored')
    expect(themeStore.getState().docSaving).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--eva-font-size')).toBe('14px')
  })

  it('queues rapid edits without losing the last live value and rolls back to the last persisted value', async () => {
    initTheme('dark')
    let finish!: (result: unknown) => void
    const first = new Promise<unknown>((resolve) => { finish = resolve })
    let writes = 0
    invoke.mockImplementation((channel: string) => {
      if (channel !== 'theme.saveDoc') return Promise.resolve({ ok: true, value: {} })
      writes += 1
      return writes === 1 ? first : Promise.resolve({ ok: false, error: { code: 'IO', message: 'read only' } })
    })
    const one = { ...themeStore.getState().doc, shared: { 'font.size': 16 } }
    const two = { ...one, shared: { 'font.size': 20 } }
    const savingOne = saveThemeDoc(one)
    const savingTwo = saveThemeDoc(two)
    const failure = expect(savingTwo).rejects.toMatchObject({ message: 'read only' })
    expect(themeStore.getState().doc).toBe(two)
    finish({ ok: true, value: {} })
    await savingOne
    await failure
    expect(writes).toBe(2)
    expect(themeStore.getState().doc).toEqual(one)
    expect(themeStore.getState().docSaving).toBe(false)
    expect(document.documentElement.style.getPropertyValue('--eva-font-size')).toBe('16px')
  })
})

describe('theme bootstrap', () => {
  it('restores the complete saved document before the renderer starts', async () => {
    const raw = {
      base: 'Flexoki',
      shared: { foreground: '#123456' },
      light: { edits: { background: '#abcdef' } },
      dark: { edits: { background: '#fedcba' } },
      app: { appearance: 'light', future: true },
      future: { enabled: true },
    }
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'theme.load') return { ok: true, value: { appearance: 'light', doc: raw } }
      if (channel === 'app.info') return { ok: true, value: { noMotion: true, e2e: false } }
      return { ok: true, value: {} }
    })
    await expect(bootstrapTheme()).resolves.toEqual({ resolved: 'light' })
    expect(themeStore.getState().doc).toEqual(parseThemeDoc(raw))
    expect(themeStore.getState().doc.raw).toBe(raw)
    expect(document.documentElement.style.getPropertyValue('--eva-c-foreground')).toBe('#123456')
    expect(document.documentElement.style.getPropertyValue('--eva-c-background')).toBe('#abcdef')
  })

  it('tolerates an older load response without a document', async () => {
    invoke.mockImplementation(async (channel: string) =>
      channel === 'theme.load'
        ? { ok: true, value: { appearance: 'dark' } }
        : { ok: true, value: { noMotion: true, e2e: false } },
    )
    await expect(bootstrapTheme()).resolves.toEqual({ resolved: 'dark' })
    expect(themeStore.getState().doc).toEqual({ ...defaultDoc(), app: { appearance: 'dark' } })
  })
})

describe('no remount', () => {
  it('keeps element identity and mount count across appearance and family switches', async () => {
    initTheme('light')
    let mounts = 0
    let el: HTMLElement | null = null
    function Probe() {
      const ref = useRef<HTMLDivElement>(null)
      useEffect(() => {
        mounts += 1
        el = ref.current
      }, [])
      return <div ref={ref} data-testid="probe" />
    }
    const setScheme = vi.fn()
    const manager = createStaticColorSchemeManager('light')
    manager.set = setScheme
    const { getByTestId } = render(
      <StrictMode>
        <MantineProvider colorSchemeManager={manager} defaultColorScheme="light">
          <ThemeBridge />
          <Probe />
        </MantineProvider>
      </StrictMode>,
    )
    const before = getByTestId('probe')
    const mountsBefore = mounts
    act(() => setAppearance('dark'))
    expect(getByTestId('probe')).toBe(before)
    expect(mounts).toBe(mountsBefore)
    expect(el).toBe(before)
    expect(themeStore.getState().resolved).toBe('dark')
    expect(setScheme).toHaveBeenCalledWith('dark')
    for (const c of setScheme.mock.calls) expect(c[0]).not.toBe('auto')
    expect(document.documentElement.getAttribute('data-mantine-color-scheme')).toBe('dark')
    await act(async () => setThemeBase('Flexoki'))
    expect(getByTestId('probe')).toBe(before)
    expect(mounts).toBe(mountsBefore)
    expect(themeStore.getState().doc.base).toBe('Flexoki')
    expect(themeStore.getState().resolved).toBe('dark')
  })
})

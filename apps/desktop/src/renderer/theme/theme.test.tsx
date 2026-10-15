import { StrictMode, useEffect, useRef } from 'react'
import { act, render } from '@testing-library/react'
import { MantineProvider } from '@mantine/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultDoc, resolveTheme } from '@evaos/theme-core'

const invoke = vi.fn()
const show = vi.fn()
vi.mock('../ipc', () => ({ invoke: (...a: unknown[]) => invoke(...a) }))
vi.mock('@mantine/notifications', () => ({
  notifications: { show: (...a: unknown[]) => show(...a) },
}))

import { applyTheme, reportBackground } from './applier'
import { createStaticColorSchemeManager } from './color-scheme-manager'
import { disposeThemeListeners, initTheme, setAppearance, themeStore } from './theme-store'
import { ThemeBridge } from './ThemeBridge'

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
})

describe('no remount', () => {
  it('keeps element identity and mount count across an appearance switch', () => {
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
  })
})

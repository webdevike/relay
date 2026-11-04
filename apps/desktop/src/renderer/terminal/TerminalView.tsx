import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { TERMINAL_PASS_THROUGH } from '@evaos/shell-core'
import type { TerminalMode } from '@evaos/contract'
import { registerTerminalScope } from '../hotkeys/router'
import { invoke } from '../ipc'
import { openLink } from '../navigation/open-link'
import { useColorScheme, useThemeConfig } from '../theme/theme-config'
import { killPty, subscribe } from './terminal-bus'
import { xtermTheme } from './xterm-theme'

export interface TerminalViewProps {
  /** The chat whose folder (shell) or herdr session (attach) this terminal belongs to. */
  file: string | null
  mode: TerminalMode
  /** A herdr pane to show view-only: keystrokes are dropped here and in main. */
  watch?: string
  /** The terminal in front of a visible panel: it spawns on first show, fits and takes focus. */
  active: boolean
  /** The pty started: where it runs and what. */
  onSpawn: (info: { cwd: string; title: string }) => void
  /** The pty ended by itself (`exit`, a herdr detach). Not called when this view ends it. */
  onExit: () => void
}

const SCROLLBACK = 5000
const FONT_SIZE = 12

/**
 * One xterm over one pty in main. Mounted for as long as its tab exists, so switching tabs or
 * panels keeps the screen and the process; unmounting ends the pty.
 */
export function TerminalView({ file, mode, watch, active, onSpawn, onExit }: TerminalViewProps) {
  const host = useRef<HTMLDivElement>(null)
  const scheme = useColorScheme()
  const config = useThemeConfig()
  const activeRef = useRef(active)
  const onExitRef = useRef(onExit)
  const onSpawnRef = useRef(onSpawn)
  const darkRef = useRef(scheme === 'dark')
  const api = useRef<{ start(): void; show(): void; retheme(): void } | null>(null)

  useEffect(() => {
    activeRef.current = active
    onExitRef.current = onExit
    onSpawnRef.current = onSpawn
    darkRef.current = scheme === 'dark'
  })

  // Create once; the pty starts the first time the terminal shows.
  useEffect(() => {
    const el = host.current
    if (!el) return
    const font = getComputedStyle(el).getPropertyValue('--eva-font-code').trim()
    const term = new Terminal({
      fontFamily: font || 'Menlo, monospace',
      fontSize: FONT_SIZE,
      cursorBlink: watch === undefined,
      scrollback: SCROLLBACK,
      macOptionIsMeta: true,
      allowProposedApi: false,
      theme: xtermTheme(el, darkRef.current),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_e, uri) => openLink(uri)))
    term.open(el)

    let disposed = false
    let id: string | null = null
    let starting = false
    let unsubscribe: (() => void) | null = null
    let dropTerminalScope: (() => void) | null = null

    const fitNow = (): void => {
      // A hidden or parked terminal has no size to fit to.
      if (el.clientWidth === 0 || el.clientHeight === 0) return
      try {
        fit.fit()
      } catch {
        // xterm throws while it has no renderer yet; the next resize fits.
      }
    }

    const start = (): void => {
      if (starting || disposed) return
      starting = true
      fitNow()
      void invoke('terminal.spawn', {
        file,
        mode,
        cols: term.cols,
        rows: term.rows,
        ...(watch === undefined ? {} : { watch }),
      }).then((r) => {
        if (!r.ok) {
          term.write(`\r\n\x1b[31m${r.error.message}\x1b[0m\r\n`)
          return
        }
        if (disposed) {
          killPty(r.value.id)
          return
        }
        id = r.value.id
        onSpawnRef.current({ cwd: r.value.cwd, title: r.value.title })
        unsubscribe = subscribe(id, {
          data: (data) => term.write(data),
          exit: () => {
            id = null
            if (!disposed) onExitRef.current()
          },
        })
        // The panel may have been resized while the pty was starting.
        void invoke('terminal.resize', { id, cols: term.cols, rows: term.rows })
      })
    }

    term.onData((data) => {
      if (id !== null && watch === undefined) void invoke('terminal.write', { id, data })
    })
    term.onResize(({ cols, rows }) => {
      if (id !== null) void invoke('terminal.resize', { id, cols, rows })
    })
    // While the terminal has focus app chords yield to it, except the few that must always work.
    term.textarea?.addEventListener('focus', () => {
      dropTerminalScope ??= registerTerminalScope(TERMINAL_PASS_THROUGH)
    })
    term.textarea?.addEventListener('blur', () => {
      dropTerminalScope?.()
      dropTerminalScope = null
    })

    const ro = new ResizeObserver(() => {
      if (activeRef.current) fitNow()
    })
    ro.observe(el)

    api.current = {
      start,
      show: () => {
        fitNow()
        term.focus()
      },
      retheme: () => {
        term.options.theme = xtermTheme(el, darkRef.current)
      },
    }
    if (activeRef.current) {
      start()
      api.current.show()
    }

    return () => {
      disposed = true
      ro.disconnect()
      dropTerminalScope?.()
      unsubscribe?.()
      if (id !== null) killPty(id)
      api.current = null
      term.dispose()
    }
    // The chat and mode a terminal was opened for never change.
  }, [])

  useEffect(() => {
    if (active) {
      api.current?.start()
      api.current?.show()
    }
  }, [active])

  // Theme follows the app (light/dark and the theme settings).
  // The provider sets the scheme on the page after its children's effects ran, so read it next frame.
  useEffect(() => {
    const frame = requestAnimationFrame(() => api.current?.retheme())
    return () => cancelAnimationFrame(frame)
  }, [scheme, config])

  return <div ref={host} className="eva-terminal-screen" data-testid="terminal-screen" />
}

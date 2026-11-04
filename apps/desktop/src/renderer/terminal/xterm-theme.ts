import type { ITheme } from '@xterm/xterm'

const ANSI_DARK = {
  black: '#1e1e1e',
  red: '#f4695f',
  green: '#7ec16e',
  yellow: '#e5c07b',
  blue: '#6cb0ff',
  magenta: '#d68cf0',
  cyan: '#5fcad6',
  white: '#d4d4d4',
  brightBlack: '#6a6f78',
  brightRed: '#ff8a80',
  brightGreen: '#9ad98a',
  brightYellow: '#f0d28f',
  brightBlue: '#8cc4ff',
  brightMagenta: '#e3a5f7',
  brightCyan: '#7edde8',
  brightWhite: '#ffffff',
}

const ANSI_LIGHT = {
  black: '#1f2328',
  red: '#c9302c',
  green: '#2e7d32',
  yellow: '#9a6700',
  blue: '#1f5fbf',
  magenta: '#8e44ad',
  cyan: '#0f7c8a',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#e5534b',
  brightGreen: '#3fa04a',
  brightYellow: '#b58105',
  brightBlue: '#388bfd',
  brightMagenta: '#a371f7',
  brightCyan: '#1b9aaa',
  brightWhite: '#8c959f',
}

/** A CSS variable resolved to the color the browser computes for it at `el`. */
function resolved(el: HTMLElement, varName: string): string {
  const probe = document.createElement('span')
  probe.style.color = `var(${varName})`
  probe.style.display = 'none'
  el.appendChild(probe)
  const value = getComputedStyle(probe).color
  probe.remove()
  return value
}

/** `rgb(r g b)` or `rgb(r, g, b)` with an alpha, as xterm wants it; anything else passes through. */
function withAlpha(css: string, alpha: number): string {
  const m = css.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/)
  return m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})` : css
}

/**
 * xterm's colors for the panel `el` sits in: its own surface and text, the accent for cursor and
 * selection, and a fixed ANSI palette per scheme.
 */
export function xtermTheme(el: HTMLElement, dark: boolean): ITheme {
  const accent = resolved(el, '--mantine-primary-color-filled')
  return {
    ...(dark ? ANSI_DARK : ANSI_LIGHT),
    background: getComputedStyle(el).backgroundColor,
    foreground: resolved(el, '--mantine-color-text'),
    cursor: accent,
    cursorAccent: getComputedStyle(el).backgroundColor,
    selectionBackground: withAlpha(accent, 0.3),
    selectionInactiveBackground: withAlpha(accent, 0.18),
  }
}

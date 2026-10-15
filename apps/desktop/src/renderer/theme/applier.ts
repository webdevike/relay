import { colorVars, shapeVars, type ResolvedTheme } from '@evaos/theme-core'
import { invoke } from '../ipc'

/** Writes every theme variable in one synchronous pass. No React state is involved. */
export function applyTheme(root: HTMLElement, resolved: ResolvedTheme): void {
  for (const [name, value] of Object.entries(colorVars(resolved))) {
    root.style.setProperty(name, value)
  }
  for (const [name, value] of Object.entries(shapeVars(resolved))) {
    root.style.setProperty(name, value)
  }
  root.dataset['resolved'] = resolved.mode
  root.style.colorScheme = resolved.mode
  root.setAttribute('data-mantine-color-scheme', resolved.mode)
}

/** The window background behind the renderer follows sidebar.background (cosmetic, errors ignored). */
export function reportBackground(resolved: ResolvedTheme): void {
  const raw = resolved.colors['sidebar.background']
  const color = raw.slice(0, 7)
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) return
  void invoke('app.setBackground', { color }).catch(() => {})
}

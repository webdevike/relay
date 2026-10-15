import { describe, expect, it } from 'vitest'
import {
  GAP,
  MAIN_MIN,
  PANEL_MIN,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  fit,
  mainWidth,
} from './fit'

describe('fit (ported from layout.rs)', () => {
  it('wide windows get the wanted widths', () => {
    expect(fit(1440, 272, 420)).toEqual({ sidebar: 272, panel: 420 })
  })

  it('the panel gives way before the sidebar', () => {
    let w = fit(1100, 272, 420)
    expect(w.sidebar).toBe(272)
    expect(w.panel).toBe(332)
    expect(mainWidth(1100, w)).toBe(MAIN_MIN)

    w = fit(1100, 420, 2000)
    expect(w.sidebar).toBe(1100 - MAIN_MIN - 2 * GAP - PANEL_MIN)
    expect(mainWidth(1100, w)).toBe(MAIN_MIN)
  })

  it('wide windows keep the preferred main minimum', () => {
    for (let window = 1100; window <= 2400; window += 25) {
      for (const sidebar of [undefined, SIDEBAR_MIN, SIDEBAR_MAX]) {
        for (const panel of [undefined, PANEL_MIN, 2000]) {
          const w = fit(window, sidebar, panel)
          expect(mainWidth(window, w)).toBeGreaterThanOrEqual(MAIN_MIN - 0.01)
          if (sidebar !== undefined) expect(w.sidebar).toBeGreaterThanOrEqual(SIDEBAR_MIN)
          if (panel !== undefined) expect(w.panel).toBeGreaterThanOrEqual(PANEL_MIN)
        }
      }
    }
  })

  it('compact cards fit without overwriting preferred widths', () => {
    for (const window of [760, 800, 900, 1100, 1440]) {
      for (const sidebar of [undefined, SIDEBAR_DEFAULT, SIDEBAR_MAX]) {
        for (const panel of [PANEL_MIN, 420, 2000]) {
          const f = fit(window, sidebar, panel)
          expect(mainWidth(window, f)).toBeGreaterThanOrEqual(416)
          expect(f.panel).toBeGreaterThanOrEqual(PANEL_MIN)
          expect(f.panel).toBeLessThanOrEqual(panel)
          expect(f.sidebar === 0 || f.sidebar >= SIDEBAR_MIN).toBe(true)
          if (window < SIDEBAR_MIN + MAIN_MIN + PANEL_MIN + 2 * GAP) expect(f.sidebar).toBe(0)
        }
      }
    }
    expect(fit(800, 272, 420).sidebar).toBe(0)
    expect(fit(800, 272, undefined).sidebar).toBe(272)
    expect(fit(1440, 272, 420).sidebar).toBe(272)
    expect(fit(1440, undefined, 420).sidebar).toBe(0)
  })

  it('handles the compact and three-column floor vectors', () => {
    expect(fit(760, 272, 420)).toEqual({ sidebar: 0, panel: 320 })
    expect(fit(1016, 272, 420).sidebar).toBe(200)
    expect(fit(1015, 272, 420).sidebar).toBe(0)
  })
})

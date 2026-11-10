import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Saved UI choices must not leak between tests. Imported late so a spec's own ipc mock applies to it.
afterEach(async () => {
  cleanup()
  ;(await import('./ui-prefs')).resetUiPrefsForTests()
})

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

// jsdom has no FontFaceSet; Mantine's autosize Textarea listens on it.
if (!(document as unknown as { fonts?: unknown }).fonts) {
  Object.defineProperty(document, 'fonts', {
    value: { addEventListener: () => {}, removeEventListener: () => {} },
  })
}

// jsdom has no ResizeObserver; Mantine's FloatingIndicator (SegmentedControl) needs one.
if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

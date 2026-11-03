import type { Page } from '@playwright/test'

type Hooks = { __evaosShell: { setAppearance(scheme: 'light' | 'dark'): void } }

/** Switches Light or Dark through the same color-scheme store Settings > Theme drives. */
export async function pickScheme(shell: Page, scheme: 'light' | 'dark'): Promise<void> {
  await shell.evaluate((s) => (window as unknown as Hooks).__evaosShell.setAppearance(s), scheme)
}

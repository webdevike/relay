import type { MantineColorScheme, MantineColorSchemeManager } from '@mantine/core'

/** theme.json is the single source of truth, so Mantine never reads or writes storage. */
export function createStaticColorSchemeManager(
  initial: 'light' | 'dark',
): MantineColorSchemeManager {
  return {
    get: () => initial as MantineColorScheme,
    set: () => {},
    subscribe: () => {},
    unsubscribe: () => {},
    clear: () => {},
  }
}

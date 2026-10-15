import { useEffect } from 'react'
import { useMantineColorScheme } from '@mantine/core'
import { useResolvedMode } from './theme-store'

/** Keeps Mantine's internal scheme in step with the resolved mode, without a remount. */
export function ThemeBridge(): null {
  const mode = useResolvedMode()
  const { setColorScheme } = useMantineColorScheme()
  useEffect(() => {
    setColorScheme(mode)
  }, [mode, setColorScheme])
  return null
}

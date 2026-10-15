import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import '@mantine/core/styles.css'
import '@mantine/charts/styles.css'
import '@mantine/notifications/styles.css'
import './styles/tokens.css'
import './styles/motion.css'
import { theme } from './theme'
import { App } from './app/App'
import { bootstrapTheme } from './theme/bootstrap'
import { createStaticColorSchemeManager } from './theme/color-scheme-manager'
import { ThemeBridge } from './theme/ThemeBridge'

async function start(): Promise<void> {
  const { resolved } = await bootstrapTheme()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <MantineProvider
        theme={theme}
        colorSchemeManager={createStaticColorSchemeManager(resolved)}
        defaultColorScheme={resolved}
      >
        <ThemeBridge />
        <Notifications position="bottom-right" />
        <App />
      </MantineProvider>
    </StrictMode>,
  )
}

void start()

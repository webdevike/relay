import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Notifications } from '@mantine/notifications'
import '@mantine/core/styles.css'
import '@mantine/charts/styles.css'
import '@mantine/code-highlight/styles.css'
import '@mantine/notifications/styles.css'
import './styles/tokens.css'
import './styles/motion.css'
import { App } from './app/App'
import { bootstrapTheme } from './theme/bootstrap'
import { ThemeProvider } from './theme/theme-config'

async function start(): Promise<void> {
  await bootstrapTheme()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ThemeProvider>
        <Notifications position="bottom-right" />
        <App />
      </ThemeProvider>
    </StrictMode>,
  )
}

void start()

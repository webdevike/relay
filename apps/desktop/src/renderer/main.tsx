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
import { startLinks } from './navigation/link-prefs'
import { startToastHoles } from './overlay/toast-holes'
import { bootstrapTheme } from './theme/bootstrap'
import { ThemeProvider } from './theme/theme-config'
import { IS_MAC } from '@evaos/shell-core'

// The window chrome differs: macOS draws its traffic lights over the page, Linux has a native frame.
document.documentElement.dataset.platform = IS_MAC ? 'mac' : 'linux'

async function start(): Promise<void> {
  await bootstrapTheme()
  void startLinks()
  startToastHoles()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ThemeProvider>
        <Notifications position="top-right" layout="stacked" className="eva-toasts" />
        <App />
      </ThemeProvider>
    </StrictMode>,
  )
}

void start()

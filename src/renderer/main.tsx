import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from '@lobehub/ui'
import { motion } from 'motion/react'
import Splash from './components/Splash'
import App from './App'
import RecoveryApp from './components/RecoveryApp'
import { initI18n } from './i18n'
import type { BootstrapData } from '../shared/ipc-types'
import './styles/index.css'

const IS_MAC = navigator.platform.toLowerCase().includes('mac')
if (IS_MAC) {
  document.documentElement.dataset.platform = 'mac'
  document.documentElement.dataset.windowFocused = 'false'
  window.api.events.onWindowFocusChanged((focused) => {
    document.documentElement.dataset.windowFocused = focused ? 'true' : 'false'
  })
}

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Root element #root not found')
}

const root = createRoot(rootElement)
root.render(<Splash />)

function mountApp(bootstrap: Pick<BootstrapData, 'language' | 'listColumnState' | 'sidebarCollapsed' | 'firstRun'>) {
  initI18n(bootstrap.language)
  root.render(
    <React.StrictMode>
      <ConfigProvider motion={motion}>
        <App
          listColumnState={bootstrap.listColumnState as never}
          sidebarCollapsed={bootstrap.sidebarCollapsed}
          firstRun={bootstrap.firstRun}
        />
      </ConfigProvider>
    </React.StrictMode>
  )
}

function mountRecoveryApp() {
  initI18n(navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en')
  root.render(
    <React.StrictMode>
      <ConfigProvider motion={motion}>
        <RecoveryApp />
      </ConfigProvider>
    </React.StrictMode>
  )
}

window.api
  .getBootstrap()
  .then((bootstrap) => {
    mountApp(bootstrap)
  })
  .catch(() => {
    mountRecoveryApp()
  })

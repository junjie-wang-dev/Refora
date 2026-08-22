import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from '@lobehub/ui'
import { motion } from 'motion/react'
import Splash from './components/Splash'
import { initI18n } from './i18n'
import type { BootstrapData } from '../shared/ipc-types'
import { normalizeBootstrapData } from '../shared/bootstrap'
import { flushRendererPersistence } from './persistence'
import './styles/index.css'

window.api.events.onRendererFlushRequested(flushRendererPersistence)

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

async function mountApp(bootstrap: Pick<BootstrapData, 'language' | 'listColumnState' | 'sidebarCollapsed' | 'firstRun'>) {
  const { default: App } = await import('./App')
  initI18n(bootstrap.language)
  root.render(
    <React.StrictMode>
      <ConfigProvider motion={motion}>
        <App
          listColumnState={bootstrap.listColumnState}
          sidebarCollapsed={bootstrap.sidebarCollapsed}
          firstRun={bootstrap.firstRun}
        />
      </ConfigProvider>
    </React.StrictMode>
  )
}

async function mountRecoveryApp() {
  const { default: RecoveryApp } = await import('./components/RecoveryApp')
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
  .then((bootstrap) => mountApp(normalizeBootstrapData(bootstrap)))
  .catch(mountRecoveryApp)

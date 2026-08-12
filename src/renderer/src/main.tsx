import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { I18nProvider } from './i18n/I18nProvider'
import { TerminalFontProvider } from './lib/terminalFont'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <TerminalFontProvider>
        <App />
      </TerminalFontProvider>
    </I18nProvider>
  </React.StrictMode>
)

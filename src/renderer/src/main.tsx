import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { I18nProvider } from './i18n/I18nProvider'
import { TerminalFontProvider } from './lib/terminalFont'
import { setPseudoLocalization } from '../../core/i18n/pseudo'
import './styles.css'

// Dev-only layout check: VITE_PSEUDO_LOCALE=1 npm run dev
setPseudoLocalization(import.meta.env.DEV && import.meta.env.VITE_PSEUDO_LOCALE === '1')

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <TerminalFontProvider>
        <App />
      </TerminalFontProvider>
    </I18nProvider>
  </React.StrictMode>
)

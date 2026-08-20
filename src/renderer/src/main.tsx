import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { I18nProvider } from './i18n/I18nProvider'
import { ThemeProvider, bootTheme } from './lib/theme'
import { TerminalFontProvider } from './lib/terminalFont'
import { setPseudoLocalization } from '../../core/i18n/pseudo'
import './styles.css'

// Dev-only layout check: VITE_PSEUDO_LOCALE=1 ASTERA_PSEUDO_LOCALE=1 npm run dev
setPseudoLocalization(import.meta.env.DEV && import.meta.env.VITE_PSEUDO_LOCALE === '1')

// 페인트 전에 심는다 — 여기서 하지 않으면 기본 테마가 한 프레임 보인다
bootTheme()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <ThemeProvider>
        <TerminalFontProvider>
          <App />
        </TerminalFontProvider>
      </ThemeProvider>
    </I18nProvider>
  </React.StrictMode>
)

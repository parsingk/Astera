import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  terminalFontFamily,
  type TerminalFont
} from '../../../core/terminal/font'

interface TerminalFontValue {
  /** The stored choice — what the settings UI shows in its two dropdowns */
  font: TerminalFont
  /** The assembled CSS font-family chain — what the xterm instances use */
  family: string
  setFont: (next: TerminalFont) => void
}

const UNSET: TerminalFont = { latin: null, hangul: null }

const Ctx = createContext<TerminalFontValue>({
  font: UNSET,
  family: DEFAULT_TERMINAL_FONT_FAMILY,
  setFont: () => {}
})

/** Holds the terminal font choice for the whole renderer.
 *  Unlike I18nProvider this renders its children immediately rather than waiting for main: the default
 *  chain is the right answer until the stored value arrives, and a terminal drawn one frame in the
 *  default font then switched is unremarkable, whereas a blank window would not be. */
export function TerminalFontProvider({ children }: { children: ReactNode }): ReactNode {
  const [font, setFontState] = useState<TerminalFont>(UNSET)

  useEffect(() => {
    // On failure the default chain stays in place — the same fallback the app had before this setting
    void window.api.settings.getTerminalFont().then(setFontState).catch(() => {})
  }, [])

  const setFont = useCallback((next: TerminalFont) => {
    setFontState(next) // optimistic; the caller reports and reverts if the save rejects
  }, [])

  return (
    <Ctx.Provider value={{ font, family: terminalFontFamily(font.latin, font.hangul), setFont }}>
      {children}
    </Ctx.Provider>
  )
}

export function useTerminalFont(): TerminalFontValue {
  return useContext(Ctx)
}

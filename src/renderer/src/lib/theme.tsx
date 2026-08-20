import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { themeCssVars } from '../../../core/theme/apply'
import {
  DEFAULT_THEME_ID,
  isThemeId,
  themeById,
  type Theme,
  type ThemeId
} from '../../../core/theme/themes'

/** 첫 페인트용 미러. IPC 는 비동기라 응답을 기다리면 기본 테마로 한 프레임 그려진 뒤 바뀐다.
 *  localStorage 는 동기라 그것이 없다 — cm.md.viewMode 와 같은 패턴. */
const KEY = 'astera.theme'

function readMirror(): ThemeId {
  const v = localStorage.getItem(KEY)
  return isThemeId(v) ? v : DEFAULT_THEME_ID
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  for (const [name, value] of Object.entries(themeCssVars(theme))) root.style.setProperty(name, value)
  // 색을 바꾸지는 않는다. devtools 에서 현재 테마가 보이고, "이 테마만" 예외가 필요할 때의 탈출구다.
  root.dataset.theme = theme.id
}

/** main.tsx 가 createRoot 전에 부른다. */
export function bootTheme(): void {
  applyTheme(themeById(readMirror()))
}

interface ThemeValue {
  theme: Theme
  setThemeId: (id: ThemeId) => void
}

const Ctx = createContext<ThemeValue>({
  theme: themeById(DEFAULT_THEME_ID),
  setThemeId: () => {}
})

export function ThemeProvider({ children }: { children: ReactNode }): ReactNode {
  const [id, setId] = useState<ThemeId>(readMirror)

  useEffect(() => {
    // 정본은 main 이다. 미러와 다르면 정본으로 바꾸고 미러를 갱신한다.
    void window.api.settings
      .getTheme()
      .then((stored) => {
        const next = isThemeId(stored) ? stored : DEFAULT_THEME_ID
        setId(next)
        localStorage.setItem(KEY, next)
      })
      .catch(() => {}) // 실패하면 미러 값이 남는다 — 앱은 계속 쓸 수 있어야 한다
  }, [])

  useEffect(() => {
    applyTheme(themeById(id))
  }, [id])

  const setThemeId = useCallback((next: ThemeId) => {
    setId(next) // 낙관적. 호출자가 실패를 알리고 되돌린다
    localStorage.setItem(KEY, next)
  }, [])

  return <Ctx.Provider value={{ theme: themeById(id), setThemeId }}>{children}</Ctx.Provider>
}

export function useTheme(): ThemeValue {
  return useContext(Ctx)
}

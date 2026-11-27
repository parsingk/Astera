import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { themeCssVars } from '../../../core/theme/apply'
import { DEFAULT_THEME_ID, themeById, type Theme } from '../../../core/theme/themes'
import { isStoredThemeId, mirrorChange, readPaletteMirror, resolveTheme, type PluginTheme } from '../../../core/plugins/pluginThemes'

/** 첫 페인트용 미러. IPC 는 비동기라 응답을 기다리면 기본 테마로 한 프레임 그려진 뒤 바뀐다.
 *  localStorage 는 동기라 그것이 없다 — cm.md.viewMode 와 같은 패턴. */
const KEY = 'astera.theme'
/** A plugin theme's colours, for the same first paint: the plugin list arrives later than the first frame (Phase 2
 *  remaining). Written only for a plugin theme the list held, and read back through the theme rules. */
const PALETTE_KEY = 'astera.theme.palette'

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const write = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // a window without storage still shows the theme; only the first frame of the next start may differ
  }
}
const remove = (key: string): void => {
  try {
    localStorage.removeItem(key)
  } catch {
    // as above
  }
}

function readMirror(): string {
  const v = read(KEY)
  return isStoredThemeId(v) ? v : DEFAULT_THEME_ID
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  for (const [name, value] of Object.entries(themeCssVars(theme))) root.style.setProperty(name, value)
  // 색을 바꾸지는 않는다. devtools 에서 현재 테마가 보이고, "이 테마만" 예외가 필요할 때의 탈출구다.
  // 그 탈출구는 styles.css 의 '테마별 예외' 절이 쓴다 — 지금은 Sirius 의 입력칸 하나뿐이다.
  // 변수 표로 낼 수 있는 것은 그쪽(core/theme/themes.ts)에 두고, 여기로 오는 것은 표로 말할 수
  // 없는 것 — 한 테마에서만 규칙의 방향이 뒤집히는 경우 — 로 한정한다. A plugin theme carries its base's id here.
  root.dataset.theme = theme.id
}

/** main.tsx 가 createRoot 전에 부른다. */
export function bootTheme(): void {
  const id = readMirror()
  applyTheme(resolveTheme(id, null, readPaletteMirror(read(PALETTE_KEY), id)))
}

interface ThemeValue {
  /** What is shown: the stored theme, or the default while no plugin offers the stored one. */
  theme: Theme
  /** What Settings stores: a built-in id, or a plugin theme's. */
  themeId: string
  setThemeId: (id: string) => void
  /** The themes plugins offer now; null until the plugin list is read. */
  pluginThemes: readonly PluginTheme[] | null
  setPluginThemes: (themes: readonly PluginTheme[] | null) => void
}

export const ThemeContext = createContext<ThemeValue>({
  theme: themeById(DEFAULT_THEME_ID),
  themeId: DEFAULT_THEME_ID,
  setThemeId: () => {},
  pluginThemes: null,
  setPluginThemes: () => {}
})

export function ThemeProvider({ children }: { children: ReactNode }): ReactNode {
  const [id, setId] = useState<string>(readMirror)
  const [pluginThemes, setPluginThemesState] = useState<readonly PluginTheme[] | null>(null)
  // A list read again with the same themes keeps the array it had, so a plugin theme is not applied again (and every
  // terminal re-themed) on each plugin list change
  const setPluginThemes = useCallback((next: readonly PluginTheme[] | null) => {
    setPluginThemesState((prev) => (prev !== null && next !== null && JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
  }, [])

  useEffect(() => {
    // 정본은 main 이다. 미러와 다르면 정본으로 바꾸고 미러를 갱신한다.
    void window.api.settings
      .getTheme()
      .then((stored) => {
        const next = isStoredThemeId(stored) ? stored : DEFAULT_THEME_ID
        setId(next)
        write(KEY, next)
      })
      .catch(() => {}) // 실패하면 미러 값이 남는다 — 앱은 계속 쓸 수 있어야 한다
  }, [])

  const theme = useMemo(() => resolveTheme(id, pluginThemes, readPaletteMirror(read(PALETTE_KEY), id)), [id, pluginThemes])

  useEffect(() => {
    applyTheme(theme)
    // The palette of a plugin theme the list holds, for the next start's first frame; gone once no plugin offers it
    const change = mirrorChange(id, pluginThemes)
    if (change === 'clear') remove(PALETTE_KEY)
    else if (change !== null) write(PALETTE_KEY, change.write)
  }, [theme, id, pluginThemes])

  const setThemeId = useCallback((next: string) => {
    setId(next) // 낙관적. 호출자가 실패를 알리고 되돌린다
    write(KEY, next)
  }, [])

  return <ThemeContext.Provider value={{ theme, themeId: id, setThemeId, pluginThemes, setPluginThemes }}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeValue {
  return useContext(ThemeContext)
}

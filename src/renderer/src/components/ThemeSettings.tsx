import { THEMES, isThemeId, type Theme } from '../../../core/theme/themes'
import { useTheme } from '../lib/theme'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'
import { useRef } from 'react'
import { createLatest } from '../lib/latest'

/** One theme's card: drawn in its own palette, a preview rather than the app's colours. */
function ThemeCard({ id, name, by, theme, on, onPick }: { id: string; name: string; by?: string; theme: Theme; on: boolean; onPick: (id: string) => void }): React.JSX.Element {
  return (
    <button
      type="button"
      className={`theme-card${on ? ' on' : ''}`}
      aria-pressed={on}
      onClick={() => onPick(id)}
      style={{
        // 카드는 자기 테마의 값으로 그린다 — 앱 테마를 따라가면 미리보기가 아니다
        background: theme.colors.bg,
        borderColor: on ? theme.colors.accent : theme.colors.line,
        borderRadius: theme.radius.lg,
        color: theme.colors.text,
        fontFamily: theme.font.sans
      }}
    >
      <span className="theme-card-bars" aria-hidden="true">
        <i style={{ background: theme.colors.rail }} />
        <i style={{ background: theme.colors.panel }} />
        <i style={{ background: theme.colors.elevated }} />
        <i style={{ background: theme.colors.accent }} />
      </span>
      <span className="theme-card-name">{name}</span>
      {by !== undefined && <span className="theme-card-by" style={{ color: theme.colors.textDim }}>{by}</span>}
    </button>
  )
}

/** 테마는 색을 보고 고르는 것이라 드롭다운이 아니라 카드다. 각 카드가 자기 팔레트로 작은 미리보기를
 *  그린다 — 표면 세 층과 액센트, 그리고 그 테마의 서체. Plugin themes (Phase 2 remaining) follow the built-in ones,
 *  each named with its plugin. */
export function ThemeSettings(): React.JSX.Element {
  const { themeId, setThemeId, pluginThemes } = useTheme()
  const { t } = useI18n()

  const latest = useRef(createLatest())
  const pick = (id: string): void => {
    const prev = themeId
    const ticket = latest.current.next()
    setThemeId(id) // 낙관적 — 즉시 보인다
    void window.api.settings.setTheme(id).catch((err) => {
      // Put back only when no later pick came (audit UI-14): reverting an older pick undid the newer one on screen.
      if (latest.current.isCurrent(ticket)) setThemeId(prev)
      toast.error(
        t('settings.theme.saveFailed', { detail: err instanceof Error ? err.message : String(err) })
      )
    })
  }
  const offered = pluginThemes ?? []
  // A stored plugin theme no plugin offers now (turned off, removed): the default is shown, the choice kept
  const gone = !isThemeId(themeId) && pluginThemes !== null && !offered.some((p) => p.id === themeId)

  return (
    <div className="settings-theme">
      <div className="settings-row">
        <span>{t('settings.theme.label')}</span>
      </div>
      <div className="theme-grid">
        {THEMES.map((th) => (
          <ThemeCard key={th.id} id={th.id} name={th.name} theme={th} on={th.id === themeId} onPick={pick} />
        ))}
      </div>
      {offered.length > 0 && (
        <>
          <div className="settings-row">
            <span>{t('settings.theme.plugins')}</span>
          </div>
          <div className="theme-grid">
            {offered.map((p) => (
              <ThemeCard key={p.id} id={p.id} name={p.name} by={p.pluginName} theme={p.theme} on={p.id === themeId} onPick={pick} />
            ))}
          </div>
        </>
      )}
      {gone && <span className="settings-hint">{t('settings.theme.pluginGone')}</span>}
      <span className="settings-hint">{t('settings.theme.hint')}</span>
    </div>
  )
}

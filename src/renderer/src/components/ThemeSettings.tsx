import { THEMES, type ThemeId } from '../../../core/theme/themes'
import { useTheme } from '../lib/theme'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'

/** 테마는 색을 보고 고르는 것이라 드롭다운이 아니라 카드다. 각 카드가 자기 팔레트로 작은 미리보기를
 *  그린다 — 표면 세 층과 액센트, 그리고 그 테마의 서체. */
export function ThemeSettings(): React.JSX.Element {
  const { theme, setThemeId } = useTheme()
  const { t } = useI18n()

  const pick = (id: ThemeId): void => {
    const prev = theme.id
    setThemeId(id) // 낙관적 — 즉시 보인다
    void window.api.settings.setTheme(id).catch((err) => {
      setThemeId(prev)
      toast.error(
        t('settings.theme.saveFailed', { detail: err instanceof Error ? err.message : String(err) })
      )
    })
  }

  return (
    <div className="settings-theme">
      <div className="settings-row">
        <span>{t('settings.theme.label')}</span>
      </div>
      <div className="theme-grid">
        {THEMES.map((th) => (
          <button
            key={th.id}
            type="button"
            className={`theme-card${th.id === theme.id ? ' on' : ''}`}
            aria-pressed={th.id === theme.id}
            onClick={() => pick(th.id)}
            style={{
              // 카드는 자기 테마의 값으로 그린다 — 앱 테마를 따라가면 미리보기가 아니다
              background: th.colors.bg,
              borderColor: th.id === theme.id ? th.colors.accent : th.colors.line,
              borderRadius: th.radius.lg,
              color: th.colors.text,
              fontFamily: th.font.sans
            }}
          >
            <span className="theme-card-bars" aria-hidden="true">
              <i style={{ background: th.colors.rail }} />
              <i style={{ background: th.colors.panel }} />
              <i style={{ background: th.colors.elevated }} />
              <i style={{ background: th.colors.accent }} />
            </span>
            <span className="theme-card-name">{th.name}</span>
          </button>
        ))}
      </div>
      <span className="settings-hint">{t('settings.theme.hint')}</span>
    </div>
  )
}

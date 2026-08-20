import { withAlpha } from './color'
import { DEFAULT_MONO, type Density, type Theme } from './themes'

interface DensityValues {
  rowPadY: string
  tabPadY: string
  selH: string
  modalPad: string
}

/** 스펙 §4.2. 밀도는 눈에 보이는 네 곳만 연다 — styles.css 의 padding 140곳을 전부 토큰화하면
 *  테마 기능이 아니라 CSS 전면 재작성이 된다. */
export const DENSITY: Record<Density, DensityValues> = {
  compact: { rowPadY: '3px', tabPadY: '5px', selH: '26px', modalPad: '16px' },
  normal: { rowPadY: '4px', tabPadY: '7px', selH: '30px', modalPad: '20px' },
  roomy: { rowPadY: '6px', tabPadY: '9px', selH: '34px', modalPad: '24px' }
}

/** 테마를 CSS 변수 표로 펼친다. 프로바이더가 이 표를 documentElement 에 심는다.
 *  DOM 을 만지지 않으므로 여기 있다 — markdownView.ts 와 같은 분리. */
export function themeCssVars(theme: Theme): Record<string, string> {
  const c = theme.colors
  const d = DENSITY[theme.density]
  return {
    '--bg': c.bg,
    '--rail': c.rail,
    '--panel': c.panel,
    '--elevated': c.elevated,
    '--surface-hover': c.surfaceHover,
    '--term-bg': c.termBg,
    '--line': c.line,
    '--line-soft': c.lineSoft,
    '--text': c.text,
    '--text-dim': c.textDim,
    '--text-faint': c.textFaint,
    '--rail-icon': c.railIcon,
    '--accent': c.accent,
    '--accent-ink': c.accentInk,
    '--ring': withAlpha(c.accent, 0.35),
    '--status-bg': c.statusBg,
    '--status-ink': c.statusInk,
    // 프리뷰는 테마를 따라간다. Orion 에서 이 넷은 IntelliJ 실측값과 같아진다.
    '--md-bg': c.bg,
    '--md-text': c.text,
    '--md-code-bg': c.elevated,
    '--md-line': c.line,
    '--md-link': c.mdLink,
    '--btn-bg': c.accent,
    '--btn-ink': c.accentInk,
    '--btn-border': 'transparent',
    '--radius': theme.radius.base,
    '--radius-lg': theme.radius.lg,
    '--radius-sm': theme.radius.sm,
    '--marker-w': theme.markerW,
    '--shadow-sm': theme.shadow.sm,
    '--shadow-lg': theme.shadow.lg,
    '--row-pad-y': d.rowPadY,
    '--tab-pad-y': d.tabPadY,
    '--sel-h': d.selH,
    '--modal-pad': d.modalPad,
    '--sans': theme.font.sans,
    '--mono': theme.font.mono ?? DEFAULT_MONO,
    '--tracking': theme.font.tracking
  }
}

/** xterm 이 받는 것. 세 개뿐인 이유는 스펙 §6.3 — ANSI 16색은 셸과 프로그램의 것이다. */
export function xtermThemeOf(theme: Theme): {
  background: string
  foreground: string
  cursor: string
} {
  return {
    background: theme.colors.termBg,
    foreground: theme.colors.text,
    cursor: theme.colors.accent
  }
}

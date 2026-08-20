/** 한글 담당을 스택에 직접 적는다 — 스펙 §4.3, 그리고 themes.test.ts 가 이것을 검사한다. */
const HANGUL = "'Malgun Gothic', 'Apple SD Gothic Neo', 'Noto Sans CJK KR', sans-serif"
/** styles.css 의 --mono 값. font.mono 가 null 인 테마는 이것을 쓴다.
 *  터미널의 mono 체인(core/terminal/font.ts)은 별개다 — 그건 사용자가 설정에서 고르는 값이고,
 *  이 값(앱 UI의 코드 서식)은 테마가 고른다. */
export const DEFAULT_MONO = "ui-monospace, 'Cascadia Code', 'JetBrains Mono', Consolas, monospace"

export type ThemeId = 'vega' | 'orion' | 'umbra' | 'aurora' | 'antares' | 'quasar'
export type Density = 'compact' | 'normal' | 'roomy'

export interface ThemeColors {
  bg: string
  rail: string
  panel: string
  elevated: string
  surfaceHover: string
  termBg: string
  line: string
  lineSoft: string
  text: string
  textDim: string
  textFaint: string
  railIcon: string
  accent: string
  accentInk: string
  statusBg: string
  statusInk: string
  mdLink: string
}

export interface Theme {
  id: ThemeId
  /** 설정에 그대로 보이는 이름. 고유명사라 번역하지 않는다. */
  name: string
  colors: ThemeColors
  radius: { base: string; lg: string; sm: string }
  /** 활성 행의 좌측 액센트 바 두께. 0 이면 배경 채움만으로 표시한다(Umbra). */
  markerW: string
  shadow: { sm: string; lg: string }
  density: Density
  /** mono 가 null 이면 DEFAULT_MONO */
  font: { sans: string; mono: string | null; tracking: string }
}

export const THEMES: readonly Theme[] = [
  {
    id: 'vega',
    name: 'Vega',
    colors: {
      bg: '#17171a', rail: '#101013', panel: '#1a1a1e', elevated: '#23232a',
      surfaceHover: '#1f1f25', termBg: '#141417', line: '#000000', lineSoft: '#26262c',
      text: '#d0d0d6', textDim: '#93939e', textFaint: '#767682', railIcon: '#a3a3ae',
      accent: '#37b0c4', accentInk: '#0d2b30', statusBg: '#0e6478', statusInk: '#d4f2f8',
      mdLink: '#4493f8'
    },
    radius: { base: '6px', lg: '8px', sm: '3px' },
    markerW: '2px',
    shadow: { sm: '0 1px 2px rgba(0,0,0,.3)', lg: '0 8px 24px rgba(0,0,0,.5)' },
    density: 'normal',
    font: { sans: `system-ui, -apple-system, 'Segoe UI', ${HANGUL}`, mono: null, tracking: '0' }
  },
  {
    id: 'orion',
    name: 'Orion',
    colors: {
      bg: '#1e1f22', rail: '#18191c', panel: '#2b2d30', elevated: '#303236',
      surfaceHover: '#2b2d30', termBg: '#1b1c1f', line: '#393b40', lineSoft: '#35373b',
      text: '#bcbec4', textDim: '#9aa0a6', textFaint: '#80858c', railIcon: '#b4b7bd',
      accent: '#4784ba', accentInk: '#061424', statusBg: '#2b2d30', statusInk: '#a5a8ae',
      mdLink: '#548af7'
    },
    radius: { base: '4px', lg: '6px', sm: '2px' },
    markerW: '2px',
    shadow: { sm: '0 1px 2px rgba(0,0,0,.25)', lg: '0 6px 18px rgba(0,0,0,.4)' },
    density: 'normal',
    font: { sans: `'IBM Plex Sans', ${HANGUL}`, mono: `'IBM Plex Mono', ${DEFAULT_MONO}`, tracking: '0' }
  },
  {
    id: 'umbra',
    name: 'Umbra',
    colors: {
      bg: '#0a0a0a', rail: '#0a0a0a', panel: '#171717', elevated: '#262626',
      surfaceHover: '#1f1f1f', termBg: '#000000',
      line: 'rgba(255,255,255,.07)', lineSoft: 'rgba(255,255,255,.07)',
      text: '#fafafa', textDim: '#a1a1a1', textFaint: '#7c7c7c', railIcon: '#c4c4c4',
      accent: '#4c7ef3', accentInk: '#06122b', statusBg: '#171717', statusInk: '#a1a1a1',
      mdLink: '#6f9dff'
    },
    radius: { base: '10px', lg: '12px', sm: '6px' },
    markerW: '0px',
    shadow: { sm: '0 2px 4px rgba(0,0,0,.5)', lg: '0 12px 32px rgba(0,0,0,.7)' },
    density: 'roomy',
    font: { sans: `'Geist', ${HANGUL}`, mono: null, tracking: '0' }
  },
  {
    id: 'aurora',
    name: 'Aurora',
    colors: {
      bg: '#181b1a', rail: '#141716', panel: '#1e2120', elevated: '#272a29',
      surfaceHover: '#232726', termBg: '#141716', line: '#252b2a', lineSoft: '#2f3534',
      text: '#eceeed', textDim: '#a1a5a4', textFaint: '#7f8483', railIcon: '#c0c4c3',
      accent: '#7ccba0', accentInk: '#14231a', statusBg: '#20744a', statusInk: '#e8f5ee',
      mdLink: '#7ccba0'
    },
    radius: { base: '8px', lg: '10px', sm: '4px' },
    markerW: '2px',
    shadow: { sm: '0 1px 3px rgba(0,0,0,.35)', lg: '0 10px 28px rgba(0,0,0,.55)' },
    density: 'normal',
    font: { sans: `'IBM Plex Sans', ${HANGUL}`, mono: null, tracking: '0' }
  },
  {
    id: 'antares',
    name: 'Antares',
    colors: {
      bg: '#1a1816', rail: '#121110', panel: '#221f1b', elevated: '#2c2822',
      surfaceHover: '#272420', termBg: '#171512', line: '#0d0c0b', lineSoft: '#302b25',
      text: '#d8d2c8', textDim: '#9a9287', textFaint: '#7d766c', railIcon: '#aaa298',
      accent: '#d1a054', accentInk: '#2a2013', statusBg: '#3a2f1e', statusInk: '#f0e2c8',
      mdLink: '#e0b774'
    },
    radius: { base: '4px', lg: '6px', sm: '2px' },
    markerW: '3px',
    shadow: { sm: '0 1px 3px rgba(0,0,0,.35)', lg: '0 10px 30px rgba(0,0,0,.55)' },
    density: 'normal',
    font: { sans: `'Geist', ${HANGUL}`, mono: null, tracking: '0.01em' }
  },
  {
    id: 'quasar',
    name: 'Quasar',
    colors: {
      bg: '#0b0b0d', rail: '#000000', panel: '#121216', elevated: '#1e1e24',
      surfaceHover: '#18181e', termBg: '#000000', line: '#2a2a32', lineSoft: '#22222a',
      text: '#e8e8ee', textDim: '#9b9baa', textFaint: '#7d7d8c', railIcon: '#c8c8d4',
      accent: '#79c98f', accentInk: '#06150b', statusBg: '#14241a', statusInk: '#cdeed7',
      mdLink: '#8ad3a0'
    },
    radius: { base: '2px', lg: '3px', sm: '1px' },
    markerW: '2px',
    // 그림자 대신 선명한 외곽선으로 층을 만든다 — 각진 모서리와 같은 성격이다.
    // sm 은 'none' 이 아니라 투명한 0 그림자다 — .sel-menu 처럼 box-shadow 목록에 다른 그림자와
    // 나란히 오는 자리가 있는데, 'none' 은 목록의 원소로 올 수 없어(단독일 때만 유효) 그 선언 전체가
    // 무효가 된다. 이 값은 그리는 게 없는 채로 목록에 낄 수 있는 진짜 no-op 이다.
    shadow: { sm: '0 0 0 0 rgba(0,0,0,0)', lg: '0 0 0 1px var(--line)' },
    density: 'compact',
    font: { sans: `'Geist', ${HANGUL}`, mono: null, tracking: '-0.01em' }
  }
]

export const DEFAULT_THEME_ID: ThemeId = 'vega'

/** localStorage 와 설정 파일에서 온 값의 신뢰 경계 — isMdViewMode 와 같은 역할. */
export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === 'string' && THEMES.some((t) => t.id === v)
}

export function themeById(id: ThemeId): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]
}

import { describe, it, expect } from 'vitest'
import { THEMES, DEFAULT_THEME_ID, isThemeId, themeById } from './themes'

describe('THEMES', () => {
  it('여섯 개이고 id 가 겹치지 않는다', () => {
    expect(THEMES).toHaveLength(6)
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(6)
  })

  it('기본값은 vega — 지금 앱의 모습이다', () => {
    expect(DEFAULT_THEME_ID).toBe('vega')
    expect(themeById('vega').name).toBe('Vega')
  })

  // 하나라도 빠지면 그 테마에서 CSS 변수가 미정의가 되어 상속된 엉뚱한 값이 나온다.
  // 눈으로는 "왜 여기만 색이 이상하지"로만 보이므로 키 집합을 못 박는다.
  it('여섯 테마의 색 키 집합이 정확히 같다', () => {
    const keys = THEMES.map((t) => Object.keys(t.colors).sort().join(','))
    expect(new Set(keys).size).toBe(1)
  })

  it('여섯 테마의 반경·그림자·서체 키 집합이 정확히 같다', () => {
    for (const t of THEMES) {
      expect(Object.keys(t.radius).sort()).toEqual(['base', 'lg', 'sm'])
      expect(Object.keys(t.shadow).sort()).toEqual(['lg', 'sm'])
      expect(Object.keys(t.font).sort()).toEqual(['mono', 'sans', 'tracking'])
    }
  })

  it('모든 --sans 스택에 한글 담당이 명시돼 있다', () => {
    // generic sans-serif 에 맡기면 Chromium 버전과 플랫폼 설정에 따라 결과가 달라진다.
    // core/terminal/font.ts 주석이 기록한 함정(mono 에서 generic 으로 떨어지면 굴림이 선택된다)과 같다.
    for (const t of THEMES) {
      expect(t.font.sans).toContain('Malgun Gothic')
      expect(t.font.sans).toContain('Apple SD Gothic Neo')
      expect(t.font.sans).toContain('Noto Sans CJK KR')
    }
  })

  it('밀도는 세 등급 중 하나다', () => {
    for (const t of THEMES) expect(['compact', 'normal', 'roomy']).toContain(t.density)
  })
})

describe('isThemeId', () => {
  it('아는 id 는 통과', () => {
    expect(isThemeId('umbra')).toBe(true)
  })

  it('모르는 값·타입이 다른 값은 거부 — localStorage 와 디스크는 사람이 고칠 수 있다', () => {
    for (const v of ['darcula', '', null, undefined, 3, {}, []]) expect(isThemeId(v)).toBe(false)
  })
})

describe('themeById', () => {
  it('아는 id 는 그 테마', () => {
    expect(themeById('quasar').id).toBe('quasar')
  })
})

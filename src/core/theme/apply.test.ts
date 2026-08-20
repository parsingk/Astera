import { describe, it, expect } from 'vitest'
import { themeCssVars, xtermThemeOf, DENSITY } from './apply'
import { themeById, THEMES, DEFAULT_MONO } from './themes'

describe('themeCssVars', () => {
  it('표면·텍스트 토큰을 CSS 변수 이름으로 낸다', () => {
    const v = themeCssVars(themeById('vega'))
    expect(v['--bg']).toBe('#17171a')
    expect(v['--text-dim']).toBe('#93939e')
    expect(v['--surface-hover']).toBe('#1f1f25')
    expect(v['--term-bg']).toBe('#141417')
  })

  it('--ring 은 액센트의 35% 알파다 — 지금 :root 의 관례', () => {
    expect(themeCssVars(themeById('vega'))['--ring']).toBe('rgba(55, 176, 196, 0.35)')
  })

  // 프리뷰는 테마를 따라간다. Orion 에서 이 파생이 IntelliJ 실측값을 그대로 재현하는 것이 설계의 핵심이다.
  it('Orion 의 프리뷰 토큰이 IntelliJ 실측값과 같다', () => {
    const v = themeCssVars(themeById('orion'))
    expect(v['--md-bg']).toBe('#1e1f22')
    expect(v['--md-text']).toBe('#bcbec4')
    expect(v['--md-code-bg']).toBe('#303236')
    expect(v['--md-line']).toBe('#393b40')
  })

  it('버튼 토큰은 액센트에서 파생한다', () => {
    const v = themeCssVars(themeById('quasar'))
    expect(v['--btn-bg']).toBe('#79c98f')
    expect(v['--btn-ink']).toBe('#06150b')
    expect(v['--btn-border']).toBe('transparent')
  })

  it('mono 가 null 인 테마는 기본 체인을 쓴다', () => {
    expect(themeCssVars(themeById('umbra'))['--mono']).toBe(DEFAULT_MONO)
  })

  it('mono 를 가진 테마는 그 값을 쓴다', () => {
    expect(themeCssVars(themeById('orion'))['--mono']).toContain('IBM Plex Mono')
  })

  it('밀도 등급이 네 개의 수치 토큰으로 펼쳐진다', () => {
    const v = themeCssVars(themeById('umbra')) // roomy
    expect(v['--row-pad-y']).toBe('6px')
    expect(v['--tab-pad-y']).toBe('9px')
    expect(v['--sel-h']).toBe('34px')
    expect(v['--modal-pad']).toBe('24px')
  })

  it('여섯 테마가 정확히 같은 변수 이름 집합을 낸다', () => {
    const sets = THEMES.map((t) => Object.keys(themeCssVars(t)).sort().join(','))
    expect(new Set(sets).size).toBe(1)
  })

  it('값이 빈 문자열인 변수가 없다 — setProperty 로 심으면 조용히 사라진다', () => {
    for (const t of THEMES) {
      for (const [name, value] of Object.entries(themeCssVars(t))) {
        expect(value, name).not.toBe('')
      }
    }
  })
})

describe('xtermThemeOf', () => {
  it('배경·전경·커서 셋만 낸다 — ANSI 16색은 건드리지 않는다', () => {
    expect(xtermThemeOf(themeById('vega'))).toEqual({
      background: '#141417',
      foreground: '#d0d0d6',
      cursor: '#37b0c4'
    })
  })

  it('Umbra 의 터미널 배경은 순검정이다', () => {
    expect(xtermThemeOf(themeById('umbra')).background).toBe('#000000')
  })
})

describe('DENSITY', () => {
  it('세 등급이 있다', () => {
    expect(Object.keys(DENSITY).sort()).toEqual(['compact', 'normal', 'roomy'])
  })
})

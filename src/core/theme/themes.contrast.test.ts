import { describe, it, expect } from 'vitest'
import { THEMES } from './themes'
import { contrastRatio } from './contrast'
import { flatten } from './color'

/** 스펙 §5. --text 는 본문을 읽는 표면(--bg)에서 AAA, 잠깐 머무는 표면에서 AA 다. 7:1 을 모든 표면에
 *  요구하면 실제로 쓰이는 IntelliJ 팔레트가 선택 행에서 6.9:1 이라 탈락한다. */
const CHECKS: { label: string; fg: keyof (typeof THEMES)[0]['colors']; bg: keyof (typeof THEMES)[0]['colors']; min: number }[] = [
  { label: 'text on bg', fg: 'text', bg: 'bg', min: 7 },
  { label: 'text on panel', fg: 'text', bg: 'panel', min: 4.5 },
  { label: 'text on elevated', fg: 'text', bg: 'elevated', min: 4.5 },
  { label: 'text-dim on elevated', fg: 'textDim', bg: 'elevated', min: 4.5 },
  { label: 'text-faint on elevated', fg: 'textFaint', bg: 'elevated', min: 3 },
  { label: 'rail-icon on rail', fg: 'railIcon', bg: 'rail', min: 4.5 },
  { label: 'accent on bg', fg: 'accent', bg: 'bg', min: 3 },
  { label: 'accent-ink on accent', fg: 'accentInk', bg: 'accent', min: 4.5 },
  { label: 'status-ink on status-bg', fg: 'statusInk', bg: 'statusBg', min: 4.5 },
  { label: 'md-link on bg', fg: 'mdLink', bg: 'bg', min: 4.5 }
]

describe.each(THEMES.map((t) => [t.id, t] as const))('%s 대비', (_id, theme) => {
  it.each(CHECKS)('$label ≥ $min', ({ fg, bg, min }) => {
    const bgColor = theme.colors[bg]
    // 알파가 있는 색은 실제로 보이는 색으로 계산한다 — Umbra 의 경계가 rgba 다
    const fgColor = flatten(theme.colors[fg], bgColor)
    expect(contrastRatio(fgColor, bgColor)).toBeGreaterThanOrEqual(min)
  })
})

/** 공유 시맨틱은 테마별로 정의하지 않으므로, 일곱 테마 중 가장 밝은 표면 하나로 검사하면 전부 통과한다.
 *  가장 밝은 표면은 Orion 의 --elevated (#303236) 다. */
const BRIGHTEST_SURFACE = '#303236'

const SHARED: Record<string, string> = {
  '--fi-blue': '#5b9fe0', '--fi-cyan': '#4fb6c4', '--fi-green': '#7fbf6a', '--fi-yellow': '#d7b45a',
  '--fi-orange': '#d68b4f', '--fi-red': '#d3706b', '--fi-purple': '#a98ede', '--fi-pink': '#d47fae',
  '--fi-gray': '#8a8a94',
  '--git-new': '#79c98f', '--git-modified': '#d7b45a', '--git-deleted': '#d3706b',
  '--git-conflict': '#d68b4f',
  '--ok': '#79c98f', '--danger': '#e5534b', '--warn': '#d9a441', '--info': '#5ac8e8',
  '--brand-claude': '#d97757', '--role-user': '#4f9cf9', '--role-assistant': '#f97316',
  '--run': '#3fb950', '--run-hover': '#57d364', '--confirm': '#2f9e6e', '--confirm-hover': '#37b07b',
  '--warn-ink': '#e8c35a', '--brand-codex': '#fff'
}

describe('공유 시맨틱', () => {
  it.each(Object.entries(SHARED))('%s 는 가장 밝은 표면에서 3:1 이상', (_name, color) => {
    expect(contrastRatio(color, BRIGHTEST_SURFACE)).toBeGreaterThanOrEqual(3)
  })

  /** --fi-mute 는 관문에서 빠진다. node_modules·빌드 폴더를 일부러 흐리게 만든 색이고(2.03:1),
   *  옆의 폴더 이름 텍스트가 의미를 지고 있어 이 색 단독으로 정보를 전달하지 않는다.
   *  값이 실수로 밝아지는 것을 막으려고 반대 방향으로 고정한다. */
  it('--fi-mute 는 일부러 흐리다 — 3:1 아래인 것이 정상이다', () => {
    expect(contrastRatio('#5f5f69', BRIGHTEST_SURFACE)).toBeLessThan(3)
  })
})

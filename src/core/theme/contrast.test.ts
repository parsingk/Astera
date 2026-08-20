import { describe, it, expect } from 'vitest'
import { relativeLuminance, contrastRatio } from './contrast'

/** styles.css 의 :root 주석이 손으로 계산해 적어 둔 값들. 계산기와 그 주석을 함께 검증한다. */
describe('contrastRatio', () => {
  it('흰색과 검정은 21:1', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 2)
  })

  it('같은 색은 1:1', () => {
    expect(contrastRatio('#17171a', '#17171a')).toBeCloseTo(1, 5)
  })

  it('--text on --bg = 11.65:1 (주석에 적힌 값)', () => {
    expect(contrastRatio('#d0d0d6', '#17171a')).toBeCloseTo(11.65, 1)
  })

  it('--text-dim on --elevated = 5.13:1', () => {
    expect(contrastRatio('#93939e', '#23232a')).toBeCloseTo(5.13, 1)
  })

  it('--text-faint on --elevated = 3.48:1', () => {
    expect(contrastRatio('#767682', '#23232a')).toBeCloseTo(3.48, 1)
  })

  it('--md-text on --md-bg = 8.87:1', () => {
    expect(contrastRatio('#bcbec4', '#1e1f22')).toBeCloseTo(8.87, 1)
  })

  it('--md-link on --md-bg = 5.32:1', () => {
    expect(contrastRatio('#4493f8', '#1e1f22')).toBeCloseTo(5.32, 1)
  })

  it('순서가 바뀌어도 같은 값', () => {
    expect(contrastRatio('#d0d0d6', '#17171a')).toBeCloseTo(contrastRatio('#17171a', '#d0d0d6'), 5)
  })
})

describe('relativeLuminance', () => {
  it('검정 0, 흰색 1', () => {
    expect(relativeLuminance('#000000')).toBeCloseTo(0, 5)
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5)
  })
})

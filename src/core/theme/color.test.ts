import { describe, it, expect } from 'vitest'
import { parseColor, withAlpha, flatten } from './color'

describe('parseColor', () => {
  it('#rrggbb 를 읽는다', () => {
    expect(parseColor('#37b0c4')).toEqual({ r: 55, g: 176, b: 196, a: 1 })
  })

  it('#rgb 축약형을 읽는다', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 })
  })

  it('rgba 의 알파를 읽는다 — Umbra 의 --line 이 이 모양이다', () => {
    expect(parseColor('rgba(255,255,255,.07)')).toEqual({ r: 255, g: 255, b: 255, a: 0.07 })
  })

  it('공백이 섞인 rgb 도 읽는다', () => {
    expect(parseColor('rgb(30, 31, 34)')).toEqual({ r: 30, g: 31, b: 34, a: 1 })
  })

  it('읽을 수 없는 값은 null — 호출자가 폴백한다', () => {
    expect(parseColor('tomato')).toBeNull()
    expect(parseColor('')).toBeNull()
  })
})

describe('withAlpha', () => {
  it('불투명 색에 알파를 씌운다 — --ring 이 액센트의 35% 다', () => {
    expect(withAlpha('#37b0c4', 0.35)).toBe('rgba(55, 176, 196, 0.35)')
  })
})

describe('flatten', () => {
  it('알파 색을 배경 위에 합성한다', () => {
    // 흰색 7% 를 #0a0a0a 위에 얹으면 각 채널이 10 + (255-10)*0.07 = 27.15 → 27
    expect(flatten('rgba(255,255,255,.07)', '#0a0a0a')).toBe('#1b1b1b')
  })

  it('불투명 색은 그대로 돌려준다', () => {
    expect(flatten('#393b40', '#1e1f22')).toBe('#393b40')
  })
})

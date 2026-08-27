import { describe, it, expect } from 'vitest'
import { formatElapsed, formatRemaining } from './elapsed'

const T0 = '2026-08-19T00:00:00.000Z'
const at = (sec: number): number => Date.parse(T0) + sec * 1000

describe('formatElapsed', () => {
  it('1분 미만은 0:SS 다', () => {
    expect(formatElapsed(T0, at(7))).toBe('0:07')
  })
  it('분과 초를 m:ss 로 적는다', () => {
    expect(formatElapsed(T0, at(134))).toBe('2:14')
  })
  it('한 시간을 넘으면 h:mm:ss 가 된다', () => {
    expect(formatElapsed(T0, at(3753))).toBe('1:02:33')
  })
  it('경계에서 0 을 채운다', () => {
    expect(formatElapsed(T0, at(60))).toBe('1:00')
    expect(formatElapsed(T0, at(3600))).toBe('1:00:00')
  })
  it('0 초는 0:00 이다', () => {
    expect(formatElapsed(T0, at(0))).toBe('0:00')
  })
  // startedAt 은 다른 프로세스의 시계에서 온다 — 앞서 있을 수 있고, 그때 음수 시간을 그리면 안 된다
  it('시작이 미래면 0:00 이다', () => {
    expect(formatElapsed(T0, at(-30))).toBe('0:00')
  })
  it('파싱할 수 없는 값이면 0:00 이다', () => {
    expect(formatElapsed('not a date', at(10))).toBe('0:00')
  })
})

describe('formatRemaining', () => {
  it('1분 미만은 0:SS 다', () => {
    expect(formatRemaining(T0, at(-7))).toBe('0:07')
  })
  it('분과 초를 m:ss 로 적는다', () => {
    expect(formatRemaining(T0, at(-134))).toBe('2:14')
  })
  it('한 시간을 넘으면 h:mm:ss 가 된다', () => {
    expect(formatRemaining(T0, at(-3753))).toBe('1:02:33')
  })
  it('경계에서 0 을 채운다', () => {
    expect(formatRemaining(T0, at(-60))).toBe('1:00')
    expect(formatRemaining(T0, at(-3600))).toBe('1:00:00')
  })
  // 이미 지난 시각(0 포함) 은 undefined 다 — "앞으로 남았다"로 보여 주면 안 되는 자리라 formatElapsed
  // 처럼 0:00 을 돌려주지 않는다. 호출부가 그 값으로 시각 없는 문구를 고른다.
  it('지금 도달한 시각은 undefined 다', () => {
    expect(formatRemaining(T0, at(0))).toBeUndefined()
  })
  it('이미 지난 시각은 undefined 다', () => {
    expect(formatRemaining(T0, at(30))).toBeUndefined()
  })
  it('파싱할 수 없는 값이면 undefined 다', () => {
    expect(formatRemaining('not a date', at(10))).toBeUndefined()
  })
})

import { describe, it, expect } from 'vitest'
import { pickInitialLang } from './locale'

describe('pickInitialLang', () => {
  it('ko-KR은 한국어', () => {
    expect(pickInitialLang('ko-KR')).toBe('ko')
  })
  it('ko 단독도 한국어', () => {
    expect(pickInitialLang('ko')).toBe('ko')
  })
  it('대문자 로케일도 한국어로 판정한다', () => {
    expect(pickInitialLang('KO-KR')).toBe('ko')
  })
  it('en-US는 영어', () => {
    expect(pickInitialLang('en-US')).toBe('en')
  })
  it('ja-JP는 일본어', () => {
    expect(pickInitialLang('ja-JP')).toBe('ja')
  })
  it('es-MX처럼 지역이 달라도 스페인어', () => {
    expect(pickInitialLang('es-MX')).toBe('es')
  })
  it('지원하지 않는 언어는 영어로 폴백', () => {
    expect(pickInitialLang('de-DE')).toBe('en')
    expect(pickInitialLang('zh-CN')).toBe('en')
  })
  it('빈 문자열도 영어', () => {
    expect(pickInitialLang('')).toBe('en')
  })
  it('언어 코드를 접두사로만 갖는 다른 언어를 잘못 집지 않는다', () => {
    // 'esk'는 스페인어가 아니다 — 하이픈 경계로만 매칭해야 한다
    expect(pickInitialLang('esk')).toBe('en')
  })
})

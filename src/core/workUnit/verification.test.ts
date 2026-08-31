import { describe, it, expect } from 'vitest'
import { verificationOf, parseCheckFlag } from './verification'

describe('verificationOf', () => {
  it('하나라도 실패면 failed 다 — 나머지가 다 통과여도', () => {
    expect(
      verificationOf([
        { name: 'tests', status: 'passed' },
        { name: 'build', status: 'failed' }
      ])
    ).toBe('failed')
  })

  it('보고된 것이 전부 통과면 verified 다', () => {
    expect(verificationOf([{ name: 'tests', status: 'passed' }])).toBe('verified')
  })

  it('통과와 건너뜀이 섞이면 partial 이다', () => {
    expect(
      verificationOf([
        { name: 'tests', status: 'passed' },
        { name: 'build', status: 'skipped' }
      ])
    ).toBe('partial')
  })

  it('전부 건너뛰었거나 아무것도 보고하지 않았으면 unverified 다', () => {
    expect(verificationOf([{ name: 'tests', status: 'skipped' }])).toBe('unverified')
    expect(verificationOf([])).toBe('unverified')
    expect(verificationOf(undefined)).toBe('unverified')
  })
})

describe('parseCheckFlag', () => {
  it('이름=상태 를 가른다', () => {
    expect(parseCheckFlag('tests=passed')).toEqual({ name: 'tests', status: 'passed' })
  })

  // The name is the agent's own words and may hold anything but the first '='
  it('이름 안의 등호는 첫 번째만 가른다', () => {
    expect(parseCheckFlag('npm run test:e2e=passed')).toEqual({
      name: 'npm run test:e2e',
      status: 'passed'
    })
  })

  it('닫힌 집합 밖의 상태는 거절한다 — 지어낸 값이 verified 로 새어 들어가지 않게', () => {
    expect(parseCheckFlag('tests=green')).toEqual({
      error: 'check status must be passed, failed or skipped: tests=green'
    })
  })

  it('등호가 없거나 이름이 비면 거절한다', () => {
    expect(parseCheckFlag('tests')).toEqual({ error: 'check must be <name>=<status>: tests' })
    expect(parseCheckFlag('=passed')).toEqual({ error: 'check must be <name>=<status>: =passed' })
  })
})

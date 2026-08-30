import { describe, it, expect } from 'vitest'
import type { PendingGitOperation } from './types'
import { isAsteraOperation, OPERATION_GRACE_MS } from './provenance'

const T0 = Date.parse('2026-08-29T10:00:00.000Z')
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString()

const op = (over: Partial<PendingGitOperation> = {}): PendingGitOperation => ({
  id: 'op-1',
  kind: 'job-merge',
  projectPath: 'D:\\p',
  startedAt: iso(0),
  ...over
})

describe('isAsteraOperation (EG §26)', () => {
  it('열려 있는 동작이 있으면 Astera 것이다', () => {
    expect(isAsteraOperation('D:\\p', T0 + 1000, [op()])).toBe(true)
  })

  it('아무 동작도 없으면 외부다', () => {
    expect(isAsteraOperation('D:\\p', T0 + 1000, [])).toBe(false)
  })

  it('다른 프로젝트의 동작은 세지 않는다', () => {
    expect(isAsteraOperation('D:\\other', T0 + 1000, [op()])).toBe(false)
  })

  it('아직 시작하지 않은 동작은 세지 않는다', () => {
    expect(isAsteraOperation('D:\\p', T0 - 1000, [op()])).toBe(false)
  })

  // 등록을 지운 직후에 감시자가 파일 이벤트를 받는 순서 역전이 실제로 가능하다.
  // 유예가 0 이면 Astera 자신의 병합이 외부 변경으로 잡힌다 (EG §41-9).
  it('방금 끝난 동작도 유예 안에서는 Astera 것이다', () => {
    const ended = op({ endedAt: iso(2000) })
    expect(isAsteraOperation('D:\\p', T0 + 2000 + OPERATION_GRACE_MS - 1, [ended])).toBe(true)
  })

  it('유예를 넘겨 끝난 동작은 외부다', () => {
    const ended = op({ endedAt: iso(2000) })
    expect(isAsteraOperation('D:\\p', T0 + 2000 + OPERATION_GRACE_MS + 1, [ended])).toBe(false)
  })

  it('망가진 시각은 없는 것으로 본다 — 던지지 않는다', () => {
    expect(isAsteraOperation('D:\\p', T0, [op({ startedAt: 'not-a-date' })])).toBe(false)
    expect(isAsteraOperation('D:\\p', T0 + 5, [op({ endedAt: 'not-a-date' })])).toBe(false)
  })

  it('여러 동작 중 하나만 맞아도 Astera 것이다', () => {
    const other = op({ id: 'op-2', projectPath: 'D:\\other' })
    expect(isAsteraOperation('D:\\p', T0 + 1000, [other, op()])).toBe(true)
  })
})

// mergeInto(등록 쪽)와 세션의 cwd(비교 쪽)는 따로 기록되어 대소문자·구분자가 다를 수 있다
// (core/orchestration/integrate.ts 의 worktreeDeps 주석과 같은 문제). 그 비교를 이 파일이 직접
// 하지 못하므로(node: 없음) 주입받는다 — 그 주입점 자체를 확인한다.
describe('isAsteraOperation — samePath 주입', () => {
  it('기본 비교는 엄격한 === 다 — 대소문자만 달라도 다른 프로젝트로 본다', () => {
    expect(isAsteraOperation('D:\\P', T0 + 1000, [op({ projectPath: 'd:\\p' })])).toBe(false)
  })

  it('주입한 비교가 같다고 하면 그 등록을 그대로 쓴다', () => {
    const caseInsensitive = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
    expect(
      isAsteraOperation(
        'D:\\P',
        T0 + 1000,
        [op({ projectPath: 'd:\\p' })],
        OPERATION_GRACE_MS,
        caseInsensitive
      )
    ).toBe(true)
  })
})

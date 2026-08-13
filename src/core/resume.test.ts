import { describe, it, expect } from 'vitest'
import { resumeAccountOptions, restoreRollAccountIds, resumeRollAccountIds } from './resume'
import type { Account } from './types'

const acc = (id: string): Account => ({
  id,
  label: id,
  configDir: `C:/cfg/${id}`,
  color: '#ffffff',
  createdAt: '2026-01-01T00:00:00Z'
})

const codexAcc = (id: string): Account => ({ ...acc(id), provider: 'codex' })

describe('resumeAccountOptions', () => {
  it('원 계정을 선두로, 로그인된 다른 계정을 뒤에(원래 순서로) 둔다', () => {
    const accounts = [acc('a'), acc('b'), acc('c')]
    const res = resumeAccountOptions(accounts, new Set(['a', 'b', 'c']), accounts[1])
    expect(res.map((a) => a.id)).toEqual(['b', 'a', 'c'])
  })

  it('로그인 안 된 계정은 후보에서 제외한다', () => {
    const accounts = [acc('a'), acc('b'), acc('c')]
    const res = resumeAccountOptions(accounts, new Set(['a', 'c']), accounts[0])
    expect(res.map((a) => a.id)).toEqual(['a', 'c']) // b(비로그인) 제외
  })

  it('원 계정이 로그인 안 됐으면 원 계정도 제외하고 로그인된 나머지만', () => {
    // 전사 파일은 디스크에 있으므로 로그인된 다른 계정으로 이어갈 수 있다
    const accounts = [acc('a'), acc('b'), acc('c')]
    const res = resumeAccountOptions(accounts, new Set(['b', 'c']), accounts[0])
    expect(res.map((a) => a.id)).toEqual(['b', 'c'])
  })

  it('로그인된 계정이 하나도 없으면 빈 배열', () => {
    const accounts = [acc('a'), acc('b')]
    const res = resumeAccountOptions(accounts, new Set<string>(), accounts[0])
    expect(res).toEqual([])
  })

  it('다른 프로바이더 계정은 후보에서 제외한다', () => {
    // 세션 파일 포맷이 CLI마다 달라 cross-provider resume은 불가 — codex 계정을 고르면
    // codex resume <claude-uuid>가 조용히 실패한다
    const accounts = [acc('a'), codexAcc('x'), acc('b')]
    const res = resumeAccountOptions(accounts, new Set(['a', 'x', 'b']), accounts[0])
    expect(res.map((a) => a.id)).toEqual(['a', 'b'])
  })

  it('owner를 아예 모르면 프로바이더를 알 수 없으므로 claude로 간주한다', () => {
    // 감지도 되지 않는 폴더에서 온 오래된 엔트리 — 후보를 못 내놓는 것보다 낫다
    const accounts = [codexAcc('x'), acc('b')]
    const res = resumeAccountOptions(accounts, new Set(['x', 'b']), undefined)
    expect(res.map((a) => a.id)).toEqual(['b'])
  })

  it('삭제된 계정(ghost)의 프로바이더로 후보를 걸러낸다', () => {
    // ghost 는 accounts 에 없으므로 id 로는 영원히 못 찾는다 — 객체로 받아야 provider 를 알 수 있다
    const ghost = { ...codexAcc('ghost:c:/cfg/old'), label: 'old@example.com' }
    const accounts = [acc('claude1'), codexAcc('codex1'), codexAcc('codex2')]
    const res = resumeAccountOptions(accounts, new Set(['claude1', 'codex1', 'codex2']), ghost)
    expect(res.map((a) => a.id)).toEqual(['codex1', 'codex2'])
  })

  it('ghost 자신은 후보에 들어가지 않는다 — 인증이 불가능하다', () => {
    const ghost = { ...acc('ghost:c:/cfg/old'), label: 'old@example.com' }
    const accounts = [acc('a'), acc('b')]
    const res = resumeAccountOptions(accounts, new Set(['a', 'b']), ghost)
    expect(res.map((a) => a.id)).toEqual(['a', 'b'])
    expect(res.some((a) => a.id.startsWith('ghost:'))).toBe(false)
  })

  it('ghost owner인데 같은 프로바이더의 로그인 계정이 없으면 빈 배열', () => {
    const ghost = { ...codexAcc('ghost:c:/cfg/old'), label: 'old@example.com' }
    const accounts = [acc('claude1')]
    const res = resumeAccountOptions(accounts, new Set(['claude1']), ghost)
    expect(res).toEqual([])
  })
})

describe('restoreRollAccountIds', () => {
  it('resume 대상 계정을 맨 앞으로 순환 재정렬한다', () => {
    expect(restoreRollAccountIds(['a', 'b', 'c'], 'b', ['a', 'b', 'c'])).toEqual(['b', 'c', 'a'])
  })

  it('resume 대상이 이미 맨 앞이면 순서 유지', () => {
    expect(restoreRollAccountIds(['a', 'b', 'c'], 'a', ['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('삭제된 계정은 필터한다', () => {
    expect(restoreRollAccountIds(['a', 'b', 'c'], 'b', ['a', 'b'])).toEqual(['b', 'a'])
  })

  it('저장 계정이 전부 삭제됐으면 빈 배열(복원 안 함)', () => {
    expect(restoreRollAccountIds(['a', 'b'], 'a', ['a'])).toEqual(['a'])
    expect(restoreRollAccountIds(['x', 'y'], 'x', ['z'])).toEqual([])
  })

  it('resume 대상이 저장 목록에 없으면 맨 앞에 추가한다', () => {
    expect(restoreRollAccountIds(['a', 'b'], 'c', ['a', 'b', 'c'])).toEqual(['c', 'a', 'b'])
  })
})

describe('resumeRollAccountIds', () => {
  it('저장값이 없으면 선택 계정 단일(자동 재개)', () => {
    expect(resumeRollAccountIds(null, [acc('a'), acc('b')], 'a')).toEqual(['a'])
    expect(resumeRollAccountIds([], [acc('a'), acc('b')], 'a')).toEqual(['a'])
  })

  it('같은 프로바이더 체인은 선택 계정을 선두로 순환 재정렬한다', () => {
    const accounts = [acc('a'), acc('b'), acc('c')]
    expect(resumeRollAccountIds(['a', 'b', 'c'], accounts, 'b')).toEqual(['b', 'c', 'a'])
  })

  it('다른 프로바이더 계정은 체인에서 걸러낸다', () => {
    // 혼합 체인은 manager가 ROLL_MIXED_PROVIDER로 거부한다 — 여기서 걸러야 spawn이 실패하지 않는다
    const accounts = [acc('a'), codexAcc('x'), acc('b')]
    expect(resumeRollAccountIds(['a', 'x', 'b'], accounts, 'a')).toEqual(['a', 'b'])
  })

  it('codex 계정으로 이어하면 codex 계정만 남는다', () => {
    const accounts = [acc('a'), codexAcc('x'), codexAcc('y')]
    expect(resumeRollAccountIds(['x', 'a', 'y'], accounts, 'x')).toEqual(['x', 'y'])
  })

  it('저장 계정이 전부 사라졌으면 선택 계정 단일로 떨어진다', () => {
    // 빈 배열을 넘기면 롤링이 조용히 등록되지 않는다 — 체크가 켜져 있으면 최소 단일 재개는 보장한다
    const accounts = [acc('a')]
    expect(resumeRollAccountIds(['gone1', 'gone2'], accounts, 'a')).toEqual(['a'])
  })

  it('선택 계정이 목록에 없으면 claude로 간주한다', () => {
    const accounts = [acc('a'), codexAcc('x')]
    expect(resumeRollAccountIds(['a'], accounts, 'gone')).toEqual(['gone', 'a'])
  })
})

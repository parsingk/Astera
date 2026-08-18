import { describe, it, expect } from 'vitest'
import { pickReviewer } from './reviewer'
import type { Account } from '../types'

const acc = (id: string, provider: 'claude' | 'codex', createdAt: string): Account => ({
  id, label: id, configDir: `D:/cfg/${id}`, color: '#fff', createdAt, provider
})

describe('pickReviewer', () => {
  it('구현자와 다른 provider 의 계정을 고른다', () => {
    const accounts = [acc('a1', 'claude', '2026-01-01T00:00:00.000Z'), acc('b1', 'codex', '2026-01-02T00:00:00.000Z')]
    expect(pickReviewer({ implProvider: 'claude', accounts, loggedInIds: new Set(['a1', 'b1']) }))
      .toEqual({ provider: 'codex', accountId: 'b1' })
  })

  it('구현자와 같은 provider 만 있으면 null 이다', () => {
    const accounts = [acc('a1', 'claude', '2026-01-01T00:00:00.000Z')]
    expect(pickReviewer({ implProvider: 'claude', accounts, loggedInIds: new Set(['a1']) })).toBeNull()
  })

  it('로그인되지 않은 계정은 쓰지 않는다', () => {
    const accounts = [acc('a1', 'claude', '2026-01-01T00:00:00.000Z'), acc('b1', 'codex', '2026-01-02T00:00:00.000Z')]
    expect(pickReviewer({ implProvider: 'claude', accounts, loggedInIds: new Set(['a1']) })).toBeNull()
  })

  // defaultAccountIdOf 의 규칙을 그대로 물려받는다 — UI 가 default 배지를 붙이는 계정과 갈라지면 안 된다
  it('같은 provider 에 계정이 여럿이면 가장 먼저 등록된 로그인 계정이다', () => {
    const accounts = [
      acc('b2', 'codex', '2026-01-03T00:00:00.000Z'),
      acc('b1', 'codex', '2026-01-02T00:00:00.000Z')
    ]
    expect(pickReviewer({ implProvider: 'claude', accounts, loggedInIds: new Set(['b1', 'b2']) }))
      .toEqual({ provider: 'codex', accountId: 'b1' })
  })

  it('계정이 하나도 없으면 null 이다', () => {
    expect(pickReviewer({ implProvider: 'claude', accounts: [], loggedInIds: new Set() })).toBeNull()
  })
})

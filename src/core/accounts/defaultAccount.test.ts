import { describe, it, expect } from 'vitest'
import type { Account, Provider } from '../types'
import { defaultAccountIdOf } from './defaultAccount'

function account(
  id: string,
  createdAt: string,
  provider?: Provider,
  label = id
): Account {
  return { id, label, configDir: `C:/cfg/${id}`, color: '#fff', createdAt, ...(provider ? { provider } : {}) }
}

describe('defaultAccountIdOf', () => {
  it('로그인된 계정 중 가장 먼저 등록된 것을 고른다', () => {
    const accounts = [
      account('b', '2026-02-01T00:00:00.000Z'),
      account('a', '2026-01-01T00:00:00.000Z'),
      account('c', '2026-03-01T00:00:00.000Z')
    ]
    expect(defaultAccountIdOf('claude', accounts, new Set(['a', 'b', 'c']))).toBe('a')
  })

  it('미로그인 계정은 더 먼저 등록됐어도 건너뛴다', () => {
    const accounts = [
      account('old', '2026-01-01T00:00:00.000Z'),
      account('new', '2026-05-01T00:00:00.000Z')
    ]
    expect(defaultAccountIdOf('claude', accounts, new Set(['new']))).toBe('new')
  })

  it('로그인된 계정이 없으면 null — 그 CLI에는 기본 계정이 없다', () => {
    const accounts = [account('a', '2026-01-01T00:00:00.000Z')]
    expect(defaultAccountIdOf('claude', accounts, new Set())).toBeNull()
    expect(defaultAccountIdOf('claude', [], new Set(['a']))).toBeNull()
  })

  it('provider마다 따로 계산한다 — codex만 쓰는 사용자도 기본 계정을 갖는다', () => {
    const accounts = [
      account('cx', '2026-01-01T00:00:00.000Z', 'codex'),
      account('cl', '2026-02-01T00:00:00.000Z', 'claude')
    ]
    const loggedIn = new Set(['cx', 'cl'])
    expect(defaultAccountIdOf('codex', accounts, loggedIn)).toBe('cx')
    expect(defaultAccountIdOf('claude', accounts, loggedIn)).toBe('cl')
  })

  it('한쪽 provider만 로그인돼 있으면 다른 쪽은 null이다', () => {
    const accounts = [
      account('cx', '2026-01-01T00:00:00.000Z', 'codex'),
      account('cl', '2026-02-01T00:00:00.000Z', 'claude')
    ]
    expect(defaultAccountIdOf('claude', accounts, new Set(['cx']))).toBeNull()
    expect(defaultAccountIdOf('codex', accounts, new Set(['cx']))).toBe('cx')
  })

  it('provider 미지정은 claude로 본다 (기존 accounts.json 호환)', () => {
    const accounts = [account('legacy', '2026-01-01T00:00:00.000Z')]
    expect(defaultAccountIdOf('claude', accounts, new Set(['legacy']))).toBe('legacy')
    expect(defaultAccountIdOf('codex', accounts, new Set(['legacy']))).toBeNull()
  })

  it('createdAt이 같으면 목록 순서(등록 순서)가 이긴다 — 자동 감지가 한 루프에서 여러 개를 등록해 동률이 난다', () => {
    const same = '2026-01-01T00:00:00.000Z'
    const accounts = [account('first', same), account('second', same)]
    expect(defaultAccountIdOf('claude', accounts, new Set(['first', 'second']))).toBe('first')
    // 순서를 뒤집으면 결과도 뒤집힌다 — 타임스탬프가 아니라 순서가 판정 근거임을 고정한다
    expect(defaultAccountIdOf('claude', [...accounts].reverse(), new Set(['first', 'second']))).toBe(
      'second'
    )
  })
})

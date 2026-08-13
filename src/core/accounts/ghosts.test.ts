import { describe, it, expect } from 'vitest'
import path from 'node:path'
import type { DetectCandidate } from './detect'
import { GHOST_ID_PREFIX, isGhostAccountId } from './ghostId'
import { ghostAccounts } from './ghosts'

const candidate = (over: Partial<DetectCandidate> = {}): DetectCandidate => ({
  configDir: path.join('C:', 'Users', 'me', '.claude-accounts', 'work'),
  loggedIn: false,
  suggestedLabel: 'work@example.com',
  provider: 'claude',
  ...over
})

describe('ghostAccounts', () => {
  it('감지 후보를 계정 모양으로 바꾼다', () => {
    const [g] = ghostAccounts([candidate()])
    expect(g.label).toBe('work@example.com')
    expect(g.configDir).toBe(candidate().configDir)
    expect(g.provider).toBe('claude')
  })

  it('id에 ghost 접두어가 붙고 isGhostAccountId로 판별된다', () => {
    const [g] = ghostAccounts([candidate()])
    expect(g.id.startsWith(GHOST_ID_PREFIX)).toBe(true)
    expect(isGhostAccountId(g.id)).toBe(true)
    expect(isGhostAccountId('7f1c1e9a-0000-4000-8000-000000000000')).toBe(false)
  })

  it('같은 configDir이면 항상 같은 id — 재시작 후에도 entryId가 유지되어야 한다', () => {
    const a = ghostAccounts([candidate()])[0]
    const b = ghostAccounts([candidate()])[0]
    expect(a.id).toBe(b.id)
  })

  it('대소문자·경로 구분자만 다른 같은 경로는 같은 id', () => {
    const a = ghostAccounts([candidate({ configDir: 'C:\\Users\\me\\.claude-accounts\\work' })])[0]
    const b = ghostAccounts([candidate({ configDir: 'C:/Users/ME/.claude-accounts/WORK' })])[0]
    expect(a.id).toBe(b.id)
  })

  it('서로 다른 configDir은 다른 id', () => {
    const a = ghostAccounts([candidate({ configDir: 'C:\\a' })])[0]
    const b = ghostAccounts([candidate({ configDir: 'C:\\b' })])[0]
    expect(a.id).not.toBe(b.id)
  })

  it('provider는 감지 결과를 그대로 싣는다 — 이어하기의 provider 판정이 여기 걸려 있다', () => {
    const [g] = ghostAccounts([candidate({ provider: 'codex', configDir: 'C:\\Users\\me\\.codex-old' })])
    expect(g.provider).toBe('codex')
  })

  it('색은 실계정 팔레트와 겹치지 않는 회색 하나로 고정한다', () => {
    const palette = ['#4f9cf9', '#f97316', '#22c55e', '#e879f9', '#facc15', '#ef4444']
    const colors = ghostAccounts([candidate({ configDir: 'C:\\a' }), candidate({ configDir: 'C:\\b' })]).map(
      (g) => g.color
    )
    expect(new Set(colors).size).toBe(1) // 전부 같은 색
    for (const c of colors) expect(palette).not.toContain(c)
  })

  it('createdAt은 고정값이다 — 순수 함수여야 하므로 현재 시각을 쓸 수 없다', () => {
    const a = ghostAccounts([candidate()])[0]
    const b = ghostAccounts([candidate()])[0]
    expect(a.createdAt).toBe(b.createdAt)
    expect(Number.isNaN(Date.parse(a.createdAt))) .toBe(false) // 포맷터가 깨지지 않는 유효한 ISO
  })

  it('후보가 없으면 빈 배열', () => {
    expect(ghostAccounts([])).toEqual([])
  })

  it('여러 후보를 순서 그대로 변환한다', () => {
    const gs = ghostAccounts([
      candidate({ configDir: 'C:\\a', suggestedLabel: 'a' }),
      candidate({ configDir: 'C:\\b', suggestedLabel: 'b' })
    ])
    expect(gs.map((g) => g.label)).toEqual(['a', 'b'])
  })
})

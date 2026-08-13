import { describe, it, expect } from 'vitest'
import path from 'node:path'
import type { DetectCandidate } from './detect'
import { suggestableCandidates } from './suggest'

const home = path.join('C:', 'Users', 'me')
const claudeRoot = path.join(home, '.claude-accounts')
const codexRoot = path.join(home, '.codex-accounts')
const roots = [claudeRoot, codexRoot]

const cand = (configDir: string, provider: DetectCandidate['provider'] = 'claude'): DetectCandidate => ({
  configDir,
  loggedIn: false,
  suggestedLabel: path.basename(configDir),
  provider
})

describe('suggestableCandidates', () => {
  it('앱이 만든 accounts root 하위의 미등록 폴더는 제안하지 않는다', () => {
    // create()가 만든 폴더가 등록돼 있지 않다면 사용자가 해제한 것이다 — 다시 권하는 것이 버그였다
    const res = suggestableCandidates(
      [cand(path.join(claudeRoot, 'gone')), cand(path.join(home, '.claude'))],
      { accountsRoots: roots, registeredCount: 3 }
    )
    expect(res.map((c) => c.configDir)).toEqual([path.join(home, '.claude')])
  })

  it('codex accounts root 하위도 같이 제외한다', () => {
    const res = suggestableCandidates([cand(path.join(codexRoot, 'gone'), 'codex')], {
      accountsRoots: roots,
      registeredCount: 1
    })
    expect(res).toEqual([])
  })

  it('accounts root 밖의 폴더는 그대로 제안한다', () => {
    const outside = [
      cand(path.join(home, '.claude')),
      cand(path.join(home, '.claude-old')),
      cand(path.join('D:', 'elsewhere', '.claude'))
    ]
    const res = suggestableCandidates(outside, { accountsRoots: roots, registeredCount: 2 })
    expect(res).toEqual(outside)
  })

  it('이름이 비슷한 형제 폴더를 root 하위로 오판하지 않는다', () => {
    // .claude-accounts2 는 .claude-accounts 의 하위가 아니다 (구분자 경계 검사)
    const sibling = cand(path.join(home, '.claude-accounts2', 'x'))
    const res = suggestableCandidates([sibling], { accountsRoots: roots, registeredCount: 1 })
    expect(res).toEqual([sibling])
  })

  it('대소문자·구분자 표기가 달라도 root 하위로 인식한다', () => {
    const res = suggestableCandidates([cand('C:/USERS/ME/.CLAUDE-ACCOUNTS/gone')], {
      accountsRoots: roots,
      registeredCount: 1
    })
    expect(res).toEqual([])
  })

  it('등록된 계정이 하나도 없으면 아무것도 걸러내지 않는다', () => {
    // 새 설치이거나 accounts.json 을 잃은 복구 상황 — 그 폴더들을 다시 찾아주는 것이 유일한 복귀 경로다.
    // 기록이 없으므로 '해제됨'과 '한 번도 등록 안 됨'을 구분할 방법도 없다
    const all = [cand(path.join(claudeRoot, 'a')), cand(path.join(codexRoot, 'b'), 'codex')]
    const res = suggestableCandidates(all, { accountsRoots: roots, registeredCount: 0 })
    expect(res).toEqual(all)
  })

  it('후보가 없으면 빈 배열', () => {
    expect(suggestableCandidates([], { accountsRoots: roots, registeredCount: 5 })).toEqual([])
  })
})

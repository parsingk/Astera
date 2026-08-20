import { describe, it, expect } from 'vitest'
import { repoPathOf } from './repo'
import { absPath } from '../testPaths'
import type { WorktreeInfo } from '../types'

const wt = (repoPath: string, p: string): WorktreeInfo => ({
  id: p,
  repoPath,
  path: p,
  name: 'feature',
  branch: 'u/feature',
  baseRef: 'origin/main',
  createdAt: '2026-08-18T00:00:00.000Z'
})

describe('repoPathOf', () => {
  it('등록된 worktree 는 만들어진 저장소 경로로 되돌린다', () => {
    // --worktree new 로 띄운 워커의 cwd 가 이 값이다. Jobs 사이드바가 이 경로로 Run 을 찾으면
    // 하나도 맞지 않는다 — Run.cwd 는 저장소 루트이기 때문
    const list = [wt(absPath('repos', 'app'), absPath('wt', 'app', 'feature'))]
    expect(repoPathOf(list, absPath('wt', 'app', 'feature'))).toBe(absPath('repos', 'app'))
  })

  it('등록되지 않은 경로는 그대로 통과시킨다', () => {
    const list = [wt(absPath('repos', 'app'), absPath('wt', 'app', 'feature'))]
    expect(repoPathOf(list, absPath('repos', 'other'))).toBe(absPath('repos', 'other'))
  })

  it('저장소 루트 자체도 그대로 통과시킨다 — 매핑은 멱등이다', () => {
    // orch.list 가 매핑한 값을 orchProject 에 담아 두고 push 가 그것을 다시 쓰므로,
    // 두 번 적용돼도 같은 값이 나와야 한다
    const list = [wt(absPath('repos', 'app'), absPath('wt', 'app', 'feature'))]
    const once = repoPathOf(list, absPath('wt', 'app', 'feature'))
    expect(repoPathOf(list, once)).toBe(absPath('repos', 'app'))
  })

  it('등록이 비어 있으면 무엇이든 그대로 통과시킨다', () => {
    expect(repoPathOf([], absPath('repos', 'app'))).toBe(absPath('repos', 'app'))
  })

  it('worktree 안의 하위 디렉터리는 되돌리지 않는다 — "포함"이 아니라 "동일"이다', () => {
    // worktree 안에 체크아웃된 중첩 저장소는 그 자신의 프로젝트다. isPathWithin 이었다면
    // 바깥 저장소의 Run 이 그 프로젝트 화면에 나타난다
    const list = [wt(absPath('repos', 'app'), absPath('wt', 'app', 'feature'))]
    const nested = absPath('wt', 'app', 'feature', 'vendor', 'lib')
    expect(repoPathOf(list, nested)).toBe(nested)
  })

  it('대소문자만 다른 같은 경로도 되돌린다 — isSamePath 의 win32-first 규칙을 따른다', () => {
    const list = [wt(absPath('repos', 'app'), absPath('wt', 'app', 'feature'))]
    const shouted = absPath('wt', 'app', 'feature').toUpperCase()
    // 플랫폼을 타지 않는다. isSamePath 의 normalizePath 는 어디서나 resolve().toLowerCase() 라서
    // (files/tree.ts 의 "win32-first" 주석) POSIX 에서도 대소문자만 다른 경로는 같은 경로다.
    // 플랫폼을 타는 것은 구분자 쪽이고, history/index.test.ts 의 hiddenPaths 테스트가 그 둘을
    // 갈라 둔 참고 사례다 — 대소문자는 무조건, `\`→`/` 치환은 win32 에서만.
    expect(repoPathOf(list, shouted)).toBe(absPath('repos', 'app'))
  })

  it('첫 번째로 일치하는 등록을 쓴다', () => {
    const p = absPath('wt', 'app', 'feature')
    const list = [wt(absPath('repos', 'app'), p), wt(absPath('repos', 'stale'), p)]
    expect(repoPathOf(list, p)).toBe(absPath('repos', 'app'))
  })
})

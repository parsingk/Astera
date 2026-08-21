import { describe, it, expect } from 'vitest'
import { goneWorktreeProjects } from './hiddenHistory'
import { absPath } from '../testPaths'

const ROOT = absPath('Users', 'me', 'astera-worktrees')
const gone = (...alive: string[]) => (p: string): boolean => alive.includes(p)

describe('goneWorktreeProjects', () => {
  it('워크트리 루트 밑에 있고 폴더가 없는 것만 고른다', () => {
    const a = absPath('Users', 'me', 'astera-worktrees', 'astera', '1')
    const b = absPath('Users', 'me', 'astera-worktrees', 'astera', '2')
    expect(goneWorktreeProjects([a, b], ROOT, gone(b))).toEqual([a])
  })

  // 사용자가 지운 *실제* 프로젝트는 감추지 않는다 — 트랜스크립트가 남아 있는 기록이고 나중에
  // 읽고 싶을 수 있다. 이 판정이 루트 밑으로 좁혀진 이유가 이것이다
  it('루트 밖의 폴더 없는 프로젝트는 고르지 않는다', () => {
    const outside = absPath('work', 'deleted-project')
    expect(goneWorktreeProjects([outside], ROOT, gone())).toEqual([])
  })

  it('루트 자신은 고르지 않는다 — 워크트리가 아니라 그것들을 담는 폴더다', () => {
    expect(goneWorktreeProjects([ROOT], ROOT, gone())).toEqual([])
  })

  it('폴더가 살아 있으면 고르지 않는다', () => {
    const alive = absPath('Users', 'me', 'astera-worktrees', 'astera', 'keep')
    expect(goneWorktreeProjects([alive], ROOT, gone(alive))).toEqual([])
  })

  it('받은 문자열을 그대로 돌려준다 — 정규화한 값을 주지 않는다', () => {
    const raw = absPath('Users', 'me', 'astera-worktrees', 'astera', 'x')
    expect(goneWorktreeProjects([raw], ROOT, gone())[0]).toBe(raw)
  })
})

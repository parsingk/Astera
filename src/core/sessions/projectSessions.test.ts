import { describe, it, expect } from 'vitest'
import type { SessionInfo } from '../types'
import { sessionsOfProject } from './projectSessions'

const s = (id: string, cwd: string): SessionInfo => ({
  id,
  accountId: 'acc-1',
  cwd,
  status: 'running',
  title: id
})

describe('sessionsOfProject', () => {
  it('cwd가 루트와 같은 세션만 고른다', () => {
    const list = [s('a', 'D:\\repo'), s('b', 'D:\\other'), s('c', 'D:\\repo')]
    expect(sessionsOfProject(list, 'D:\\repo').map((x) => x.id)).toEqual(['a', 'c'])
  })

  it('입력 순서를 유지한다 — 탭 순서가 흔들리면 안 된다', () => {
    const list = [s('c', 'D:\\repo'), s('a', 'D:\\repo')]
    expect(sessionsOfProject(list, 'D:\\repo').map((x) => x.id)).toEqual(['c', 'a'])
  })

  it('대소문자와 구분자 차이를 무시한다 (win32 우선 규칙)', () => {
    const list = [s('a', 'D:/Repo')]
    expect(sessionsOfProject(list, 'd:\\repo').map((x) => x.id)).toEqual(['a'])
  })

  it('끝의 구분자 유무를 무시한다', () => {
    const list = [s('a', 'D:\\repo\\')]
    expect(sessionsOfProject(list, 'D:\\repo').map((x) => x.id)).toEqual(['a'])
  })

  // worktree 세션은 cwd가 다른 디렉터리이므로 부모 프로젝트에 잡히지 않는다 — 의도된 동작이다
  it('하위 디렉터리에서 도는 세션은 포함하지 않는다', () => {
    const list = [s('a', 'D:\\repo\\sub'), s('b', 'D:\\repo-wt')]
    expect(sessionsOfProject(list, 'D:\\repo')).toEqual([])
  })

  it('루트가 null이면 빈 배열', () => {
    expect(sessionsOfProject([s('a', 'D:\\repo')], null)).toEqual([])
  })
})

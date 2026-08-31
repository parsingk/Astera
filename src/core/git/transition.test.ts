import { describe, it, expect } from 'vitest'
import { classifyTransition } from './transition'

const at = (branch: string | null, head: string | null): { branch: string | null; head: string | null } => ({
  branch,
  head
})

describe('classifyTransition (EG §22)', () => {
  it('아무것도 안 바뀌었으면 none', () => {
    expect(classifyTransition(at('main', 'abc'), at('main', 'abc'), null)).toBe('none')
  })

  it('브랜치가 바뀌었으면 branch-switch — head 도 함께 바뀌었더라도 그렇다', () => {
    expect(classifyTransition(at('main', 'abc'), at('develop', 'def'), false)).toBe('branch-switch')
    expect(classifyTransition(at('main', 'abc'), at('develop', 'abc'), true)).toBe('branch-switch')
  })

  it('같은 브랜치에서 before 가 after 의 조상이면 fast-forward — git pull 이 이 모양이다', () => {
    expect(classifyTransition(at('main', 'abc'), at('main', 'def'), true)).toBe('fast-forward')
  })

  it('같은 브랜치인데 조상이 아니면 history-rewritten — rebase·reset 이 이 모양이다', () => {
    expect(classifyTransition(at('main', 'abc'), at('main', 'def'), false)).toBe('history-rewritten')
  })

  it('git 이 조상 여부를 답하지 못하면 unknown — 억지로 추정하지 않는다', () => {
    expect(classifyTransition(at('main', 'abc'), at('main', 'def'), null)).toBe('unknown')
  })

  it('before 에 커밋이 없었으면 unknown — 조상 관계를 물을 수 없다', () => {
    expect(classifyTransition(at('main', null), at('main', 'abc'), null)).toBe('unknown')
  })

  it('detached HEAD 는 branch 가 null 이고, null 끼리는 같은 것으로 본다', () => {
    expect(classifyTransition(at(null, 'abc'), at(null, 'abc'), null)).toBe('none')
    expect(classifyTransition(at(null, 'abc'), at('main', 'abc'), null)).toBe('branch-switch')
  })
})

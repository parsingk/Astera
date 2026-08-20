import { describe, it, expect } from 'vitest'
import { KNOWLEDGE_DIRS, KNOWLEDGE_MAX, knowledgeFilesFrom } from './knowledge'

describe('KNOWLEDGE_DIRS', () => {
  // 자기 관례 하나만 찾는 도구는 이 저장소 밖에서 아무것도 찾지 못한다 — knowledge/README.md 가
  // 그 근거를 적어 두었다("a tool that only finds its own convention finds nothing")
  it('흔한 관례 여섯을 본다', () => {
    expect(KNOWLEDGE_DIRS).toEqual([
      'knowledge',
      'docs/adr',
      'docs/decisions',
      'docs/architecture',
      'adr',
      'doc/adr'
    ])
  })
})

describe('knowledgeFilesFrom', () => {
  it('빈 목록이면 빈 결과다', () => {
    expect(knowledgeFilesFrom([])).toEqual({ paths: [], more: 0 })
  })

  // 순서가 정해져 있어야 같은 저장소에서 두 번 띄운 워커가 같은 spec 을 받는다 — readdir 의
  // 순서는 플랫폼이 정한다
  it('경로를 정렬한다', () => {
    const out = knowledgeFilesFrom(['knowledge/b.md', 'adr/a.md', 'knowledge/a.md'])
    expect(out.paths).toEqual(['adr/a.md', 'knowledge/a.md', 'knowledge/b.md'])
  })

  it('같은 경로가 두 번 오면 하나로 접는다', () => {
    const out = knowledgeFilesFrom(['adr/a.md', 'adr/a.md'])
    expect(out.paths).toEqual(['adr/a.md'])
    expect(out.more).toBe(0)
  })

  // 상한은 디렉터리별이 아니라 전체다 — 여섯 관례를 다 가진 저장소에서 240줄이 되면 안 된다
  it('상한을 넘으면 앞의 40개만 남기고 남은 개수를 적는다', () => {
    const many = Array.from({ length: 47 }, (_, i) => `knowledge/${String(i).padStart(3, '0')}.md`)
    const out = knowledgeFilesFrom(many)
    expect(out.paths).toHaveLength(KNOWLEDGE_MAX)
    expect(out.paths[0]).toBe('knowledge/000.md')
    expect(out.more).toBe(7)
  })

  it('상한과 정확히 같으면 자르지 않는다', () => {
    const exact = Array.from({ length: KNOWLEDGE_MAX }, (_, i) => `k/${i}.md`)
    const out = knowledgeFilesFrom(exact)
    expect(out.paths).toHaveLength(KNOWLEDGE_MAX)
    expect(out.more).toBe(0)
  })
})

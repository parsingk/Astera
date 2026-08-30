// 이 모듈이 없을 때 첫 분석은 이 저장소에서 10분을 넘겨도 끝나지 않았다(스펙 §29). 여기서 지키는
// 것은 "재료가 실린다"와 "재료가 프롬프트를 삼키지 않는다" 둘이다.
import { describe, it, expect } from 'vitest'
import { DOC_CANDIDATES, orderDirectories, sketchText, SKIP_DIRS } from './context'

describe('sketchText', () => {
  const s = {
    directories: ['src', 'src/core'],
    docs: [{ path: 'README.md', head: '# Astera\n세션 관리자' }]
  }

  it('디렉터리와 문서가 모두 실린다', () => {
    const t = sketchText(s)
    expect(t).toContain('- src/core')
    expect(t).toContain('--- README.md ---')
    expect(t).toContain('# Astera')
  })

  // 재료가 프롬프트를 삼키면 §24 계약이 뒤로 밀려 지켜지지 않는다
  it('한도를 넘으면 자르고 잘렸다고 말한다', () => {
    const big = { directories: [], docs: [{ path: 'a.md', head: 'x'.repeat(500) }] }
    const t = sketchText(big, 100)
    expect(t.length).toBeLessThan(140)
    expect(t).toContain('잘림')
  })

  it('아무것도 없으면 빈 문자열이다 — 빈 머리글만 남기지 않는다', () => {
    expect(sketchText({ directories: [], docs: [] })).toBe('')
  })

  it('문서가 없으면 디렉터리만 남는다', () => {
    const t = sketchText({ directories: ['src'], docs: [] })
    expect(t).toBe('Directories:\n- src')
  })
})

describe('orderDirectories', () => {
  // 얕은 것이 기능을 잘 말한다 — `src/core` 가 `src/core/understanding/messages` 보다
  it('얕은 것부터, 같은 깊이면 이름순', () => {
    expect(orderDirectories(['src/core/a', 'b', 'src/z', 'src/a'])).toEqual([
      'b',
      'src/a',
      'src/z',
      'src/core/a'
    ])
  })

  it('너무 많으면 자른다 — 그리고 잘리는 것은 언제나 깊은 쪽이다', () => {
    const dirs = ['deep/a/b/c', 'x', 'y']
    expect(orderDirectories(dirs, 2)).toEqual(['x', 'y'])
  })
})

describe('훑지 않는 곳', () => {
  // 이것을 세면 "node_modules 관리"가 기능 목록에 오른다
  it('빌드 산출물과 의존성이 목록에 있다', () => {
    for (const d of ['node_modules', '.git', 'dist', 'out', 'coverage']) expect(SKIP_DIRS.has(d)).toBe(true)
    expect(SKIP_DIRS.has('src')).toBe(false)
  })

  it('README 가 첫 후보다 — 이 프로젝트가 무엇인지 가장 짧게 말하는 곳이다', () => {
    expect(DOC_CANDIDATES[0]).toBe('README.md')
  })
})

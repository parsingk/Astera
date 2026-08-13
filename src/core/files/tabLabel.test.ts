import { describe, it, expect } from 'vitest'
import { tabLabels } from './tabLabel'

const hintOf = (paths: string[], p: string): string | null => tabLabels(paths).get(p)!.hint
const nameOf = (paths: string[], p: string): string => tabLabels(paths).get(p)!.name

describe('tabLabels', () => {
  it('이름은 언제나 마지막 경로 조각이다', () => {
    expect(nameOf(['D:\\repo\\src\\a.ts'], 'D:\\repo\\src\\a.ts')).toBe('a.ts')
  })

  it('겹치지 않으면 구분자가 없다', () => {
    const paths = ['D:\\repo\\a.ts', 'D:\\repo\\b.ts']
    expect(hintOf(paths, 'D:\\repo\\a.ts')).toBeNull()
    expect(hintOf(paths, 'D:\\repo\\b.ts')).toBeNull()
  })

  it('겹치면 갈라지는 최소 조각만 붙는다', () => {
    const paths = ['D:\\repo\\src\\api\\index.ts', 'D:\\repo\\src\\web\\index.ts']
    expect(hintOf(paths, 'D:\\repo\\src\\api\\index.ts')).toBe('api')
    expect(hintOf(paths, 'D:\\repo\\src\\web\\index.ts')).toBe('web')
  })

  // 한 단계 위가 같으면 갈라질 때까지 더 올라간다
  it('한 단계로 갈라지지 않으면 두 단계까지 올라간다', () => {
    const paths = ['D:\\repo\\a\\x\\f.ts', 'D:\\repo\\b\\x\\f.ts']
    expect(hintOf(paths, 'D:\\repo\\a\\x\\f.ts')).toBe('a/x')
    expect(hintOf(paths, 'D:\\repo\\b\\x\\f.ts')).toBe('b/x')
  })

  // 프로젝트가 다른 같은 이름도 같은 규칙 하나로 덮인다
  it('프로젝트가 다르면 프로젝트 쪽에서 갈라진다', () => {
    const paths = ['D:\\p1\\src\\a.ts', 'D:\\p2\\src\\a.ts']
    expect(hintOf(paths, 'D:\\p1\\src\\a.ts')).toBe('p1/src')
    expect(hintOf(paths, 'D:\\p2\\src\\a.ts')).toBe('p2/src')
  })

  it('같은 이름이 셋이어도 모두 서로 달라질 때까지 올라간다', () => {
    const paths = ['D:\\r\\a\\f.ts', 'D:\\r\\b\\f.ts', 'D:\\r\\c\\f.ts']
    expect(hintOf(paths, 'D:\\r\\a\\f.ts')).toBe('a')
    expect(hintOf(paths, 'D:\\r\\c\\f.ts')).toBe('c')
  })

  it('구분자는 표시용이므로 항상 슬래시로 낸다', () => {
    const paths = ['D:\\r\\a\\x\\f.ts', 'D:\\r\\b\\x\\f.ts']
    expect(hintOf(paths, 'D:\\r\\a\\x\\f.ts')).toBe('a/x')
  })

  it('빈 목록과 경로 하나짜리를 견딘다', () => {
    expect(tabLabels([]).size).toBe(0)
    expect(hintOf(['D:\\a.ts'], 'D:\\a.ts')).toBeNull()
  })
})

import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { sortEntries, isPathWithin, buildIgnoreMatcher, type DirEntry } from './tree'

const e = (name: string, isDir: boolean): DirEntry => ({ name, path: `D:\\p\\${name}`, isDir })

describe('sortEntries', () => {
  it('폴더를 파일보다 먼저, 각 그룹은 이름순으로 정렬한다', () => {
    const sorted = sortEntries([e('b.ts', false), e('src', true), e('a.ts', false), e('docs', true)])
    expect(sorted.map((x) => x.name)).toEqual(['docs', 'src', 'a.ts', 'b.ts'])
  })

  it('이름 비교는 대소문자를 무시한다', () => {
    const sorted = sortEntries([e('Zeta', true), e('alpha', true), e('README.md', false), e('index.ts', false)])
    expect(sorted.map((x) => x.name)).toEqual(['alpha', 'Zeta', 'index.ts', 'README.md'])
  })

  it('원본 배열을 변경하지 않는다', () => {
    const input = [e('b', false), e('a', true)]
    sortEntries(input)
    expect(input.map((x) => x.name)).toEqual(['b', 'a'])
  })
})

describe('isPathWithin', () => {
  const base = 'D:\\work\\proj'

  it('동일 경로와 하위 경로를 허용한다', () => {
    expect(isPathWithin(base, 'D:\\work\\proj')).toBe(true)
    expect(isPathWithin(base, 'D:\\work\\proj\\src\\a.ts')).toBe(true)
  })

  it('대소문자·구분자 차이를 무시한다', () => {
    expect(isPathWithin(base, 'd:\\WORK\\proj\\src')).toBe(true)
    expect(isPathWithin(base, 'D:/work/proj/src')).toBe(true)
  })

  it('형제 prefix 경로를 거부한다 (D:\\work\\proj2)', () => {
    expect(isPathWithin(base, 'D:\\work\\proj2')).toBe(false)
    expect(isPathWithin(base, 'D:\\work\\proj2\\a.ts')).toBe(false)
  })

  it('상위 경로와 .. 탈출을 거부한다', () => {
    expect(isPathWithin(base, 'D:\\work')).toBe(false)
    expect(isPathWithin(base, path.join(base, '..', 'other'))).toBe(false)
  })
})

describe('buildIgnoreMatcher', () => {
  it('gitignore 없이도 크로스랭귀지 heavy 디렉토리를 제외한다', () => {
    const ig = buildIgnoreMatcher(null)
    for (const p of ['node_modules', 'node_modules/x/y.js', '.git', 'target', 'a/target/b', '__pycache__', 'sub/.venv/z', 'build', 'dist', 'bin', 'obj']) {
      expect(ig(p)).toBe(true)
    }
    for (const p of ['src', 'src/index.ts', 'README.md', 'a/b/main.py']) {
      expect(ig(p)).toBe(false)
    }
  })

  it('루트 경로("")는 제외하지 않는다', () => {
    expect(buildIgnoreMatcher(null)('')).toBe(false)
  })

  it('gitignore 패턴을 큐레이트 목록에 합쳐 적용한다', () => {
    const ig = buildIgnoreMatcher('*.log\ncustom-out/\n')
    expect(ig('app.log')).toBe(true)
    expect(ig('logs/app.log')).toBe(true)
    expect(ig('custom-out/x')).toBe(true)
    expect(ig('node_modules')).toBe(true) // 큐레이트도 여전히 적용
    expect(ig('src/index.ts')).toBe(false)
  })

  it('윈도우 역슬래시 경로도 판정한다', () => {
    expect(buildIgnoreMatcher(null)('a\\node_modules\\x')).toBe(true)
    expect(buildIgnoreMatcher(null)('src\\index.ts')).toBe(false)
  })
})

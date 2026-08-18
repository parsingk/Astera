import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { sortEntries, isPathWithin, projectRootOf, buildIgnoreMatcher, type DirEntry } from './tree'
import { absPath } from '../testPaths'

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
  const base = absPath('work', 'proj')

  it('동일 경로와 하위 경로를 허용한다', () => {
    expect(isPathWithin(base, absPath('work', 'proj'))).toBe(true)
    expect(isPathWithin(base, absPath('work', 'proj', 'src', 'a.ts'))).toBe(true)
  })

  it('대소문자 차이를 무시한다', () => {
    expect(isPathWithin(base, absPath('WORK', 'proj', 'src'))).toBe(true)
  })

  // 구분자 무시는 win32에서만 의미가 있다 — POSIX에서 `\`는 구분자가 아니라 이름에 쓸 수 있는 글자다
  it.runIf(process.platform === 'win32')('win32에서는 구분자 차이도 무시한다', () => {
    expect(isPathWithin(base, 'd:\\WORK\\proj\\src')).toBe(true)
    expect(isPathWithin(base, 'D:/work/proj/src')).toBe(true)
  })

  it('형제 prefix 경로를 거부한다 (…/proj2)', () => {
    expect(isPathWithin(base, absPath('work', 'proj2'))).toBe(false)
    expect(isPathWithin(base, absPath('work', 'proj2', 'a.ts'))).toBe(false)
  })

  it('상위 경로와 .. 탈출을 거부한다', () => {
    expect(isPathWithin(base, 'D:\\work')).toBe(false)
    expect(isPathWithin(base, path.join(base, '..', 'other'))).toBe(false)
  })
})

describe('projectRootOf', () => {
  it('후보 중 target을 담는 것으로 되돌린다', () => {
    const roots = [absPath('work', 'proj')]
    expect(projectRootOf(roots, absPath('work', 'proj', 'src', 'main'))).toBe(absPath('work', 'proj'))
  })

  // 중첩된 후보가 있을 때 바깥으로 올라가면, 중첩 프로젝트의 Run이 부모 프로젝트 목록에
  // 섞여 든다 — 소유 판정을 '동일'로 좁혀서 막아 둔 바로 그 누수가 저장 시점에서 되살아난다
  it('중첩된 후보 중 가장 긴 것을 고른다', () => {
    const roots = [absPath('work'), absPath('work', 'proj'), absPath('work', 'proj', 'nested')]
    expect(projectRootOf(roots, absPath('work', 'proj', 'nested', 'src'))).toBe(
      absPath('work', 'proj', 'nested')
    )
  })

  it('target 자신이 후보면 그것을 돌려준다', () => {
    const roots = [absPath('work', 'proj')]
    expect(projectRootOf(roots, absPath('work', 'proj'))).toBe(absPath('work', 'proj'))
  })

  // 앱이 아직 모르는 경로에도 Run은 만들어질 수 있다. 여기서 던지거나 빈 값을 주면
  // 오케스트레이션이 멈춘다 — 정규화는 최선 노력이지 검증이 아니다
  it('담는 후보가 없으면 target을 그대로 돌려준다', () => {
    const roots = [absPath('other')]
    expect(projectRootOf(roots, absPath('work', 'proj'))).toBe(absPath('work', 'proj'))
  })

  it('후보가 비어 있으면 target을 그대로 돌려준다', () => {
    expect(projectRootOf([], absPath('work', 'proj'))).toBe(absPath('work', 'proj'))
  })

  // 형제 접두사 — D:\proj 가 D:\proj2 를 담는 것으로 오인되면 안 된다
  it('이름이 접두사인 형제 디렉터리는 담는 것으로 보지 않는다', () => {
    const roots = [absPath('work', 'proj')]
    expect(projectRootOf(roots, absPath('work', 'proj2', 'src'))).toBe(absPath('work', 'proj2', 'src'))
  })

  // 돌려주는 값은 정규화된 문자열이 아니라 roots 에 들어온 원본이어야 한다 —
  // 이 값이 Run.cwd 로 저장되므로 실제로 존재하는 경로 표기를 유지해야 한다
  it.runIf(process.platform === 'win32')('win32에서 대소문자 차이를 무시하고, 후보의 원본 표기를 돌려준다', () => {
    expect(projectRootOf(['D:\\Work\\Proj'], 'd:\\work\\proj\\src')).toBe('D:\\Work\\Proj')
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

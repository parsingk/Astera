import { describe, it, expect } from 'vitest'
import { repoPathOf, sameRepoPath } from './repoPath'

// Phase 3 Part 4: a review issue's file, as the reviewer wrote it, against a diff's repo-relative path
describe('repoPathOf', () => {
  it('writes a path relative to the repo with forward slashes and no leading ./', () => {
    expect(repoPathOf('src\\a.ts', 'F:\\proj', 'win32')).toBe('src/a.ts')
    expect(repoPathOf('./src/a.ts', 'F:\\proj', 'win32')).toBe('src/a.ts')
    expect(repoPathOf('F:\\Proj\\src\\한글 폴더\\a.ts', 'f:\\proj', 'win32')).toBe('src/한글 폴더/a.ts')
    expect(repoPathOf('/home/u/p/src/a.ts', '/home/u/p', 'linux')).toBe('src/a.ts')
  })
  it('leaves an absolute path outside the repo as it is', () => {
    expect(repoPathOf('F:\\other\\a.ts', 'F:\\proj', 'win32')).toBe('F:/other/a.ts')
  })
})

describe('sameRepoPath', () => {
  it('folds case on win32 only', () => {
    expect(sameRepoPath('Src/A.ts', 'src/a.ts', 'win32')).toBe(true)
    expect(sameRepoPath('Src/A.ts', 'src/a.ts', 'linux')).toBe(false)
  })
})

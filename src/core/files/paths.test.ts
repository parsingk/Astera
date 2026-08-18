import { describe, it, expect } from 'vitest'
import { parentDir, resolveRelative } from './paths'

describe('parentDir', () => {
  it('마지막 구분자 앞까지 돌려준다 (역슬래시/슬래시 모두)', () => {
    expect(parentDir('D:\\a\\b\\c.ts')).toBe('D:\\a\\b')
    expect(parentDir('D:/a/b')).toBe('D:/a')
  })
  it('구분자가 없으면 원본 반환', () => {
    expect(parentDir('x')).toBe('x')
  })
})

describe('resolveRelative', () => {
  it('같은 폴더의 파일', () => {
    expect(resolveRelative('C:/p/README.md', 'a.png')).toBe('C:/p/a.png')
    expect(resolveRelative('C:/p/README.md', './a.png')).toBe('C:/p/a.png')
  })
  it('하위 폴더', () => {
    expect(resolveRelative('C:/p/README.md', 'assets/a.png')).toBe('C:/p/assets/a.png')
    expect(resolveRelative('C:/p/docs/x.md', './img/a.png')).toBe('C:/p/docs/img/a.png')
  })
  it('상위로 올라간다', () => {
    expect(resolveRelative('C:/p/docs/x.md', '../a.png')).toBe('C:/p/a.png')
    expect(resolveRelative('C:/p/docs/deep/x.md', '../../a.png')).toBe('C:/p/a.png')
  })
  it('루트 위로는 올라가지 않는다', () => {
    expect(resolveRelative('C:/x.md', '../../../a.png')).toBe('C:/a.png')
  })
  // Windows 경로가 섞여 온다 — 탐색기는 백슬래시를, 마크다운은 슬래시를 쓴다
  it('구분자가 섞여도 원래 구분자를 지킨다', () => {
    expect(resolveRelative('C:\\p\\README.md', 'assets/a.png')).toBe('C:\\p\\assets\\a.png')
    expect(resolveRelative('C:\\p\\docs\\x.md', '../a.png')).toBe('C:\\p\\a.png')
  })
  it('중간의 . 을 지운다', () => {
    expect(resolveRelative('C:/p/x.md', './a/./b.png')).toBe('C:/p/a/b.png')
  })
  it('빈 상대경로는 문서가 있는 폴더', () => {
    expect(resolveRelative('C:/p/x.md', '')).toBe('C:/p')
  })
})

import { describe, expect, it } from 'vitest'
import { flattenVisible, rangeBetween } from './selection'

// R
//  ├ a/            (폴더)
//  │  ├ b.ts
//  │  └ c/         (폴더)
//  │     └ d.ts
//  └ z.ts
const dirs = {
  R: {
    entries: [
      { path: 'R\\a', isDir: true },
      { path: 'R\\z.ts', isDir: false }
    ]
  },
  'R\\a': {
    entries: [
      { path: 'R\\a\\b.ts', isDir: false },
      { path: 'R\\a\\c', isDir: true }
    ]
  },
  'R\\a\\c': { entries: [{ path: 'R\\a\\c\\d.ts', isDir: false }] }
}

describe('flattenVisible', () => {
  it('펼치지 않은 폴더의 자식은 목록에 없다', () => {
    expect(flattenVisible('R', dirs, new Set())).toEqual(['R\\a', 'R\\z.ts'])
  })

  it('펼친 폴더는 그 자리에서 펼쳐진다 (형제보다 앞)', () => {
    expect(flattenVisible('R', dirs, new Set(['R\\a']))).toEqual([
      'R\\a',
      'R\\a\\b.ts',
      'R\\a\\c',
      'R\\z.ts'
    ])
  })

  it('중첩 펼침을 재귀로 따라간다', () => {
    expect(flattenVisible('R', dirs, new Set(['R\\a', 'R\\a\\c']))).toEqual([
      'R\\a',
      'R\\a\\b.ts',
      'R\\a\\c',
      'R\\a\\c\\d.ts',
      'R\\z.ts'
    ])
  })

  it('펼쳐졌지만 아직 캐시가 없는 폴더는 건너뛴다 (로딩 중)', () => {
    const partial = { R: dirs.R }
    expect(flattenVisible('R', partial, new Set(['R\\a']))).toEqual(['R\\a', 'R\\z.ts'])
  })

  it('루트 캐시가 없으면 빈 배열', () => {
    expect(flattenVisible('R', {}, new Set())).toEqual([])
  })

  it('펼침 셋에 파일이 들어 있어도 무시한다', () => {
    expect(flattenVisible('R', dirs, new Set(['R\\z.ts']))).toEqual(['R\\a', 'R\\z.ts'])
  })
})

describe('rangeBetween', () => {
  const flat = ['a', 'b', 'c', 'd']

  it('양끝을 포함한 구간을 준다', () => {
    expect(rangeBetween(flat, 'b', 'd')).toEqual(['b', 'c', 'd'])
  })

  it('역방향도 같은 구간을 준다', () => {
    expect(rangeBetween(flat, 'd', 'b')).toEqual(['b', 'c', 'd'])
  })

  it('같은 항목이면 그것 하나', () => {
    expect(rangeBetween(flat, 'c', 'c')).toEqual(['c'])
  })

  it('한쪽이 목록에 없으면 있는 쪽 하나만', () => {
    expect(rangeBetween(flat, 'zzz', 'c')).toEqual(['c'])
    expect(rangeBetween(flat, 'c', 'zzz')).toEqual(['c'])
  })

  it('둘 다 없으면 빈 배열', () => {
    expect(rangeBetween(flat, 'zzz', 'yyy')).toEqual([])
  })
})

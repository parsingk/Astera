import { describe, it, expect } from 'vitest'
import { parentDir } from './paths'

describe('parentDir', () => {
  it('마지막 구분자 앞까지 돌려준다 (역슬래시/슬래시 모두)', () => {
    expect(parentDir('D:\\a\\b\\c.ts')).toBe('D:\\a\\b')
    expect(parentDir('D:/a/b')).toBe('D:/a')
  })
  it('구분자가 없으면 원본 반환', () => {
    expect(parentDir('x')).toBe('x')
  })
})

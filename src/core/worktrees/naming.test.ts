import { describe, it, expect } from 'vitest'
import path from 'node:path'
import {
  slugify, autoName, branchNameFor, candidateName, repoDirName, worktreePathFor, MAX_SUFFIX_ATTEMPTS
} from './naming'

describe('slugify', () => {
  it('공백·특수문자는 -로, 연속 -는 축약', () => {
    expect(slugify('login fix!!')).toBe('login-fix')
    expect(slugify('a  b//c')).toBe('a-b-c')
  })
  it('유니코드 문자(한글)는 유지', () => {
    expect(slugify('로그인 수정')).toBe('로그인-수정')
  })
  it('..은 .으로 축약, 앞뒤 .-는 트림', () => {
    expect(slugify('..a..b..')).toBe('a.b')
    expect(slugify('-x-')).toBe('x')
  })
  it('유효 문자가 없으면 INVALID_NAME', () => {
    expect(() => slugify('!!!')).toThrow(/INVALID_NAME/)
    expect(() => slugify('   ')).toThrow(/INVALID_NAME/)
  })
})

describe('autoName', () => {
  it('random 주입 시 결정적이고 slug 규칙을 통과한다', () => {
    const a = autoName(() => 0)
    const b = autoName(() => 0.999)
    expect(a).not.toBe(b)
    expect(slugify(a)).toBe(a)
  })
})

describe('branchNameFor', () => {
  it('user.name을 slug화해 prefix로', () => {
    expect(branchNameFor('Park JP', 'login-fix')).toBe('Park-JP/login-fix')
  })
  it('user.name 없거나 slug 불가면 slug만', () => {
    expect(branchNameFor(null, 'login-fix')).toBe('login-fix')
    expect(branchNameFor('!!!', 'login-fix')).toBe('login-fix')
  })
})

describe('candidateName / MAX_SUFFIX_ATTEMPTS', () => {
  it('1회차는 그대로, n회차는 -n', () => {
    expect(candidateName('x', 1)).toBe('x')
    expect(candidateName('x', 2)).toBe('x-2')
  })
  it('상한은 20', () => expect(MAX_SUFFIX_ATTEMPTS).toBe(20))
})

describe('repoDirName / worktreePathFor', () => {
  it('.git 접미사 제거', () => {
    expect(repoDirName('D:\\repos\\my-app.git')).toBe('my-app')
  })
  it('루트/repo명/slug 조합', () => {
    expect(worktreePathFor('D:\\wt', 'D:\\repos\\my-app', 'fix')).toBe(
      path.join('D:\\wt', 'my-app', 'fix')
    )
  })
})

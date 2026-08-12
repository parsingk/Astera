import { describe, expect, it } from 'vitest'
import { validateName, uniqueName, isSubPath, rebasePath, canMove, canCopy, topLevelOnly } from './ops'

describe('validateName', () => {
  it('정상 이름은 통과한다', () => {
    expect(validateName('foo.txt')).toBeNull()
    expect(validateName('한글 파일.md')).toBeNull()
    expect(validateName('.gitignore')).toBeNull()
    expect(validateName('a.b.c')).toBeNull()
  })

  it('빈 이름·공백만은 거절한다', () => {
    expect(validateName('')).toEqual({ key: 'files.validate.empty' })
    expect(validateName('   ')).toEqual({ key: 'files.validate.empty' })
  })

  it('. 과 .. 은 거절한다', () => {
    expect(validateName('.')).toEqual({ key: 'files.validate.reserved' })
    expect(validateName('..')).toEqual({ key: 'files.validate.reserved' })
  })

  it('경로 구분자는 거절한다', () => {
    expect(validateName('a/b')).toEqual({ key: 'files.validate.separator' })
    expect(validateName('a\\b')).toEqual({ key: 'files.validate.separator' })
  })

  it('Windows 금지 문자는 어떤 문자인지 알려주며 거절한다', () => {
    expect(validateName('a<b')).toEqual({ key: 'files.validate.badChar', params: { char: '<' } })
    expect(validateName('a?b')).toEqual({ key: 'files.validate.badChar', params: { char: '?' } })
    expect(validateName('a:b')).toEqual({ key: 'files.validate.badChar', params: { char: ':' } })
    expect(validateName('a"b')).toEqual({ key: 'files.validate.badChar', params: { char: '"' } })
    expect(validateName('a|b')).toEqual({ key: 'files.validate.badChar', params: { char: '|' } })
    expect(validateName('a*b')).toEqual({ key: 'files.validate.badChar', params: { char: '*' } })
    expect(validateName('a\u0007b')).toEqual({
      key: 'files.validate.badChar',
      params: { char: 'U+0007' }
    })
  })

  it('Windows 예약어는 확장자가 붙어도, 대소문자가 달라도 거절한다', () => {
    expect(validateName('CON')).toEqual({ key: 'files.validate.windowsReserved' })
    expect(validateName('con.txt')).toEqual({ key: 'files.validate.windowsReserved' })
    expect(validateName('Com7.log')).toEqual({ key: 'files.validate.windowsReserved' })
    expect(validateName('LPT9')).toEqual({ key: 'files.validate.windowsReserved' })
    // 예약어가 이름의 일부인 것은 허용 — CONSOLE, console.ts
    expect(validateName('CONSOLE')).toBeNull()
    expect(validateName('console.ts')).toBeNull()
  })

  it('끝 공백·마침표는 거절한다', () => {
    expect(validateName('a ')).toEqual({ key: 'files.validate.trailing' })
    expect(validateName('a.')).toEqual({ key: 'files.validate.trailing' })
  })

  it('255자 초과는 거절한다', () => {
    expect(validateName('x'.repeat(255))).toBeNull()
    expect(validateName('x'.repeat(256))).toEqual({ key: 'files.validate.tooLong' })
  })
})

describe('uniqueName', () => {
  it('충돌이 없으면 그대로 돌려준다', () => {
    expect(uniqueName(['b.txt'], 'a.txt')).toBe('a.txt')
  })

  it("확장자를 보존하며 ' copy'를 붙인다", () => {
    expect(uniqueName(['a.txt'], 'a.txt')).toBe('a copy.txt')
    expect(uniqueName(['a.txt', 'a copy.txt'], 'a.txt')).toBe('a copy 2.txt')
    expect(uniqueName(['a.txt', 'a copy.txt', 'a copy 2.txt'], 'a.txt')).toBe('a copy 3.txt')
  })

  it('확장자 없는 이름(폴더)은 뒤에 붙인다', () => {
    expect(uniqueName(['dist'], 'dist')).toBe('dist copy')
    expect(uniqueName(['dist', 'dist copy'], 'dist')).toBe('dist copy 2')
  })

  it("dot 파일은 전체를 이름으로 본다 — '.env' → '.env copy'", () => {
    expect(uniqueName(['.env'], '.env')).toBe('.env copy')
  })

  it('비교는 대소문자를 무시한다 (win32 파일시스템)', () => {
    expect(uniqueName(['A.TXT'], 'a.txt')).toBe('a copy.txt')
  })
})

describe('isSubPath', () => {
  it('자기 자신과 하위는 참', () => {
    expect(isSubPath('D:\\proj', 'D:\\proj')).toBe(true)
    expect(isSubPath('D:\\proj', 'D:\\proj\\src\\a.ts')).toBe(true)
  })

  it('형제 접두사 오탐을 내지 않는다', () => {
    expect(isSubPath('D:\\proj', 'D:\\proj2\\a.ts')).toBe(false)
  })

  it('구분자·대소문자 차이를 무시한다', () => {
    expect(isSubPath('d:/PROJ', 'D:\\proj\\a.ts')).toBe(true)
  })
})

describe('rebasePath', () => {
  it('접두사를 새 경로로 치환하고 원본 구분자를 유지한다', () => {
    expect(rebasePath('D:\\proj\\src\\a.ts', 'D:\\proj\\src', 'D:\\proj\\lib')).toBe('D:\\proj\\lib\\a.ts')
  })

  it('base 자신이면 toBase를 그대로 돌려준다', () => {
    expect(rebasePath('D:\\proj\\src', 'D:\\proj\\src', 'D:\\proj\\lib')).toBe('D:\\proj\\lib')
  })

  it('접두사가 아니면 원본을 그대로 돌려준다', () => {
    expect(rebasePath('D:\\other\\a.ts', 'D:\\proj', 'D:\\lib')).toBe('D:\\other\\a.ts')
  })
})

describe('canMove', () => {
  it('자기 하위로의 이동은 순환이라 거절한다', () => {
    expect(canMove('D:\\proj\\src', 'D:\\proj\\src\\inner')).toEqual({ key: 'files.move.intoSelf' })
    expect(canMove('D:\\proj\\src', 'D:\\proj\\src')).toEqual({ key: 'files.move.intoSelf' })
  })

  it('같은 부모로의 이동은 no-op 사유를 준다', () => {
    expect(canMove('D:\\proj\\src\\a.ts', 'D:\\proj\\src')).toEqual({ key: 'files.move.alreadyThere' })
  })

  it('정상 이동은 통과한다', () => {
    expect(canMove('D:\\proj\\src\\a.ts', 'D:\\proj\\lib')).toBeNull()
  })
})

describe('canCopy', () => {
  it('자기 자신 안으로의 복사는 거절한다', () => {
    expect(canCopy('D:\\proj\\src', 'D:\\proj\\src')).toEqual({ key: 'files.copy.intoSelf' })
  })

  it('자기 하위로의 복사도 거절한다', () => {
    expect(canCopy('D:\\proj\\src', 'D:\\proj\\src\\inner')).toEqual({ key: 'files.copy.intoSelf' })
  })

  it('같은 부모로의 복사는 허용한다 — uniqueName이 회피한다 (canMove와 다른 점)', () => {
    expect(canCopy('D:\\proj\\src\\a.ts', 'D:\\proj\\src')).toBeNull()
  })

  it('다른 폴더로의 복사는 허용한다', () => {
    expect(canCopy('D:\\proj\\src\\a.ts', 'D:\\proj\\lib')).toBeNull()
  })
})

describe('topLevelOnly', () => {
  it('다른 항목의 하위인 것을 제거한다', () => {
    expect(topLevelOnly(['D:\\p\\a', 'D:\\p\\a\\b.ts'])).toEqual(['D:\\p\\a'])
  })

  it('깊은 하위도 제거한다', () => {
    expect(topLevelOnly(['D:\\p\\a', 'D:\\p\\a\\x\\y\\z.ts'])).toEqual(['D:\\p\\a'])
  })

  it('형제는 모두 남긴다', () => {
    expect(topLevelOnly(['D:\\p\\a', 'D:\\p\\b'])).toEqual(['D:\\p\\a', 'D:\\p\\b'])
  })

  it('입력 순서를 보존한다 (하위가 부모보다 앞에 와도)', () => {
    expect(topLevelOnly(['D:\\p\\b', 'D:\\p\\a\\c.ts', 'D:\\p\\a'])).toEqual([
      'D:\\p\\b',
      'D:\\p\\a'
    ])
  })

  it('형제 접두사 오탐을 내지 않는다', () => {
    expect(topLevelOnly(['D:\\p\\a', 'D:\\p\\a2\\x.ts'])).toEqual(['D:\\p\\a', 'D:\\p\\a2\\x.ts'])
  })

  it('구분자·대소문자가 달라도 부모-자식을 알아본다', () => {
    expect(topLevelOnly(['d:/P/a', 'D:\\p\\A\\b.ts'])).toEqual(['d:/P/a'])
  })

  it('빈 배열은 빈 배열', () => {
    expect(topLevelOnly([])).toEqual([])
  })
})

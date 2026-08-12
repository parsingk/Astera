import { describe, expect, it } from 'vitest'
import { DEFAULT_TERMINAL_FONT_FAMILY, sanitizeFontFamily, terminalFontFamily } from './font'

describe('sanitizeFontFamily', () => {
  it('keeps an ordinary family name', () => {
    expect(sanitizeFontFamily('Cascadia Mono')).toBe('Cascadia Mono')
    expect(sanitizeFontFamily('D2Coding_v1.3')).toBe('D2Coding_v1.3')
    expect(sanitizeFontFamily('  Consolas  ')).toBe('Consolas')
  })

  it('rejects anything that could break out of the CSS declaration', () => {
    expect(sanitizeFontFamily('Foo", monospace; color:red')).toBeNull()
    expect(sanitizeFontFamily("Foo'")).toBeNull()
    expect(sanitizeFontFamily('Foo\nBar')).toBeNull()
    expect(sanitizeFontFamily('Foo\\Bar')).toBeNull()
    expect(sanitizeFontFamily('Foo,Bar')).toBeNull()
    expect(sanitizeFontFamily('Foo{Bar}')).toBeNull()
  })

  it('keeps a non-ASCII family name, including Hangul', () => {
    expect(sanitizeFontFamily('맑은 고딕')).toBe('맑은 고딕')
  })

  it('treats empty and over-long input as unset', () => {
    expect(sanitizeFontFamily('   ')).toBeNull()
    expect(sanitizeFontFamily('a'.repeat(65))).toBeNull()
    expect(sanitizeFontFamily(null)).toBeNull()
    expect(sanitizeFontFamily(42)).toBeNull()
  })
})

describe('terminalFontFamily', () => {
  it('reproduces the historical chain when nothing is set', () => {
    expect(terminalFontFamily(null, null)).toBe(
      '"Cascadia Mono", "Cascadia Code", Consolas, "Malgun Gothic", "Courier New", monospace'
    )
    expect(DEFAULT_TERMINAL_FONT_FAMILY).toBe(terminalFontFamily(null, null))
  })

  it('puts the latin font first and the hangul font before Malgun Gothic', () => {
    expect(terminalFontFamily('Fira Code', null)).toBe(
      '"Fira Code", "Cascadia Mono", "Cascadia Code", Consolas, "Malgun Gothic", "Courier New", monospace'
    )
    expect(terminalFontFamily(null, 'D2Coding')).toBe(
      '"Cascadia Mono", "Cascadia Code", Consolas, "D2Coding", "Malgun Gothic", "Courier New", monospace'
    )
    expect(terminalFontFamily('Fira Code', 'D2Coding')).toBe(
      '"Fira Code", "Cascadia Mono", "Cascadia Code", Consolas, "D2Coding", "Malgun Gothic", "Courier New", monospace'
    )
  })

  it('drops a name that does not survive sanitising', () => {
    expect(terminalFontFamily('Foo"; color:red', null)).toBe(terminalFontFamily(null, null))
  })
})

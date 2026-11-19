import { describe, it, expect } from 'vitest'
import { shellQuote } from './shellQuote'

describe('shellQuote', () => {
  it('leaves a plain argument alone', () => {
    expect(shellQuote('--context=prod-1', 'linux')).toBe('--context=prod-1')
    expect(shellQuote('/p/a.yaml', 'win32')).toBe('/p/a.yaml')
  })
  it('quotes a space, a dollar sign and a backtick', () => {
    expect(shellQuote('a b', 'linux')).toBe("'a b'")
    expect(shellQuote('$HOME', 'linux')).toBe("'$HOME'")
    expect(shellQuote('a`b', 'win32')).toBe("'a`b'")
  })
  it('keeps the backslashes of a Windows path', () => {
    const bs = String.fromCharCode(92)
    const path = ['C:', 'p', 'a.yaml'].join(bs)
    expect(shellQuote(path, 'win32')).toBe("'" + path + "'")
  })
  it('writes an empty argument as two quotes', () => {
    expect(shellQuote('', 'linux')).toBe("''")
  })
  it('escapes an inner single quote per platform', () => {
    expect(shellQuote("it's", 'win32')).toBe("'it''s'")
    expect(shellQuote("it's", 'darwin')).toBe("'it'" + String.fromCharCode(92) + "''s'")
  })
})

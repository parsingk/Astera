import { describe, it, expect } from 'vitest'
import { languageForExt, classifyExternalChange } from './edit'

describe('languageForExt', () => {
  it('확장자를 CM6 언어 키로 매핑한다', () => {
    expect(languageForExt('a/b/x.ts')).toBe('javascript')
    expect(languageForExt('x.tsx')).toBe('javascript')
    expect(languageForExt('x.py')).toBe('python')
    expect(languageForExt('x.rs')).toBe('rust')
    expect(languageForExt('x.YAML')).toBe('yaml')
    expect(languageForExt('Dockerfile')).toBeNull()
    expect(languageForExt('x.unknownext')).toBeNull()
  })
})

describe('classifyExternalChange', () => {
  it('디스크가 savedContent와 같으면 무시(자기 저장 포함)', () => {
    expect(classifyExternalChange('abc', 'abc', false)).toBe('ignore')
    expect(classifyExternalChange('abc', 'abc', true)).toBe('ignore')
  })
  it('내용 다르고 미수정이면 reload', () => {
    expect(classifyExternalChange('new', 'old', false)).toBe('reload')
  })
  it('내용 다르고 수정중이면 conflict', () => {
    expect(classifyExternalChange('new', 'old', true)).toBe('conflict')
  })
})

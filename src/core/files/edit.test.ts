import { describe, it, expect } from 'vitest'
import { languageForExt, classifyExternalChange, sameDocument } from './edit'

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

describe('sameDocument — 줄바꿈 차이를 무시한 문서 비교', () => {
  it('CRLF와 LF는 같은 문서다 — 캐시된 EditorState가 재사용되지 못하던 원인', () => {
    expect(sameDocument('a\r\nb\r\nc', 'a\nb\nc')).toBe(true)
  })

  it('완전히 같은 문자열은 정규화 없이 통과한다', () => {
    expect(sameDocument('a\nb', 'a\nb')).toBe(true)
  })

  it('맥 클래식의 단독 CR도 접는다 — CodeMirror가 그것으로도 줄을 나눈다', () => {
    expect(sameDocument('a\rb', 'a\nb')).toBe(true)
  })

  it('줄바꿈이 섞여 있어도 같다', () => {
    expect(sameDocument('a\r\nb\nc\rd', 'a\nb\nc\nd')).toBe(true)
  })

  it('내용이 다르면 다르다 — 줄바꿈만 무시하지 나머지를 무시하지 않는다', () => {
    expect(sameDocument('a\r\nb', 'a\r\nB')).toBe(false)
    expect(sameDocument('a\r\nb', 'a\r\nb\r\nc')).toBe(false)
  })

  it('빈 문자열끼리는 같고, 빈 문자열과 줄바꿈 하나는 다르다', () => {
    expect(sameDocument('', '')).toBe(true)
    expect(sameDocument('', '\n')).toBe(false)
  })
})

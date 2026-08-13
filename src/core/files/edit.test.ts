import { describe, it, expect } from 'vitest'
import {
  languageForExt,
  classifyExternalChange,
  sameDocument,
  detectEol,
  toLf,
  applyEol
} from './edit'

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

describe('detectEol — 파일이 쓰는 줄바꿈', () => {
  it('CRLF만 있으면 CRLF', () => {
    expect(detectEol('a\r\nb\r\nc')).toBe('\r\n')
  })

  it('LF만 있으면 LF', () => {
    expect(detectEol('a\nb\nc')).toBe('\n')
  })

  it('줄바꿈이 없으면 LF — 적용해도 아무것도 바뀌지 않는다', () => {
    expect(detectEol('한 줄뿐')).toBe('\n')
    expect(detectEol('')).toBe('\n')
  })

  // 앞 문자를 삼키는 정규식으로 세면 연속된 빈 줄이 한 번으로 세어져 CRLF 쪽으로 기운다
  it('연속된 빈 줄도 각각 센다', () => {
    expect(detectEol('a\r\nb\n\n\n\nc')).toBe('\n')
  })

  // 첫 줄바꿈만 보고 정하면 LF 파일에 CRLF가 한 줄 섞였을 때 파일 전체가 CRLF로 바뀐다
  it('섞여 있으면 다수를 따른다', () => {
    expect(detectEol('a\r\nb\nc\nd\ne')).toBe('\n')
    expect(detectEol('a\r\nb\r\nc\r\nd\ne')).toBe('\r\n')
  })
})

describe('toLf / applyEol — 파일시스템 경계에서의 변환', () => {
  it('toLf는 CRLF와 단독 CR을 모두 LF로 만든다', () => {
    expect(toLf('a\r\nb\rc\nd')).toBe('a\nb\nc\nd')
  })

  it('applyEol은 CRLF 파일의 줄바꿈을 되돌린다', () => {
    expect(applyEol('a\nb\nc', '\r\n')).toBe('a\r\nb\r\nc')
  })

  it('LF 파일은 그대로 둔다', () => {
    expect(applyEol('a\nb', '\n')).toBe('a\nb')
  })

  // 이미 CRLF가 섞인 텍스트를 그대로 치환하면 \r\r\n이 된다 — 항상 LF로 정규화한 뒤 적용한다
  it('CRLF가 섞여 들어와도 \r\r\n을 만들지 않는다', () => {
    expect(applyEol('a\r\nb\nc', '\r\n')).toBe('a\r\nb\r\nc')
  })

  it('왕복해도 원본과 같다', () => {
    const disk = 'a\r\nb\r\nc'
    expect(applyEol(toLf(disk), detectEol(disk))).toBe(disk)
  })
})

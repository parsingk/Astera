import { describe, it, expect } from 'vitest'
import { sessionLabelOf } from './changeRecord'

describe('sessionLabelOf — 스펙 표기("세션 …")에 id 앞 여덟 자다', () => {
  it('세션 id 의 앞 여덟 자를 붙인다', () => {
    expect(sessionLabelOf('41b7384a-0050-4ce5-b638-52d80affbf6d')).toBe('세션 41b7384a')
  })
})

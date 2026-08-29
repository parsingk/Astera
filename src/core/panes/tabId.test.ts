import { describe, it, expect } from 'vitest'
import { featureTab, fileTab, parseTab, sessionTab } from './tabId'

describe('탭 id', () => {
  it('기능 탭을 만들고 되읽는다', () => {
    expect(featureTab('auth')).toBe('feature:auth')
    expect(parseTab('feature:auth')).toEqual({ kind: 'feature', id: 'auth' })
  })

  it('기존 두 종류가 그대로다', () => {
    expect(parseTab(sessionTab('s1'))).toEqual({ kind: 'session', id: 's1' })
    expect(parseTab(fileTab('C:/a/b.ts'))).toEqual({ kind: 'file', id: 'C:/a/b.ts' })
  })

  it('모르는 종류는 null — 옛 저장 상태를 만나도 화면이 죽지 않는다', () => {
    expect(parseTab('widget:x')).toBeNull()
    expect(parseTab('feature:')).toBeNull()
    expect(parseTab('nocolon')).toBeNull()
  })
})

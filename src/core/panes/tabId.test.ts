import { describe, it, expect } from 'vitest'
import { featureTab, fileTab, parseTab, sessionTab } from './tabId'

describe('tabId', () => {
  it('세션 탭 id를 만들고 되읽는다', () => {
    expect(sessionTab('sess-1')).toBe('session:sess-1')
    expect(parseTab('session:sess-1')).toEqual({ kind: 'session', id: 'sess-1' })
  })

  it('파일 탭 id는 기존 형식과 같다 — file: 다음에 경로 전체', () => {
    expect(fileTab('D:\\repo\\a.ts')).toBe('file:D:\\repo\\a.ts')
  })

  // Windows 경로에는 콜론이 있다. 첫 콜론으로만 쪼개지 않으면 드라이브 문자에서 잘린다.
  it('경로에 콜론이 있어도 첫 콜론으로만 쪼갠다', () => {
    expect(parseTab('file:D:\\repo\\a.ts')).toEqual({ kind: 'file', id: 'D:\\repo\\a.ts' })
  })

  it('기능 탭을 만들고 되읽는다', () => {
    expect(featureTab('auth')).toBe('feature:auth')
    expect(parseTab('feature:auth')).toEqual({ kind: 'feature', id: 'auth' })
  })

  it('접두사가 없거나 알 수 없는 종류는 null', () => {
    expect(parseTab('sess-1')).toBeNull()
    expect(parseTab('run:1')).toBeNull()
    expect(parseTab('widget:x')).toBeNull()
  })

  it('종류만 있고 id가 빈 문자열이면 null', () => {
    expect(parseTab('session:')).toBeNull()
    expect(parseTab('feature:')).toBeNull()
  })

  // 콜론으로 시작하는 문자열은 종류가 빈 문자열이므로 탭 id가 아니다
  it('콜론으로 시작하면 null', () => {
    expect(parseTab(':sess-1')).toBeNull()
  })
})

import { describe, it, expect } from 'vitest'
import { appTab, browserTab, recordTab, fileTab, parseTab, sessionTab, remoteSessionKey, parseRemoteSessionKey, isRemoteSessionKey } from './tabId'

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

  it('기록 탭을 만들고 되읽는다', () => {
    expect(recordTab('auth')).toBe('record:auth')
    expect(parseTab('record:auth')).toEqual({ kind: 'record', id: 'auth' })
  })

  it('접두사가 없거나 알 수 없는 종류는 null', () => {
    expect(parseTab('sess-1')).toBeNull()
    expect(parseTab('run:1')).toBeNull()
    expect(parseTab('widget:x')).toBeNull()
  })

  it('종류만 있고 id가 빈 문자열이면 null', () => {
    expect(parseTab('session:')).toBeNull()
    expect(parseTab('record:')).toBeNull()
  })

  it('미리보기 탭을 만들고 되읽는다', () => {
    expect(browserTab('8d0f')).toBe('browser:8d0f')
    expect(parseTab('browser:8d0f')).toEqual({ kind: 'browser', id: '8d0f' })
  })

  it('미리보기 탭도 id 가 빈 문자열이면 null', () => {
    expect(parseTab('browser:')).toBeNull()
  })

  // 콜론으로 시작하는 문자열은 종류가 빈 문자열이므로 탭 id가 아니다
  it('콜론으로 시작하면 null', () => {
    expect(parseTab(':sess-1')).toBeNull()
  })

  it('an app mirror tab is one per session, by session id', () => {
    expect(appTab('s-1')).toBe('app:s-1')
    expect(parseTab('app:s-1')).toEqual({ kind: 'app', id: 's-1' })
    expect(parseTab('app:')).toBeNull()
  })

  // Remote Runtime Phase 9b (D1.4): a remote session's key is `<runtimeId>:<sessionId>`, so its tab is
  // `session:<runtimeId>:<sessionId>` and a local session's tab does not change.
  it('a remote session key makes the remote tab id and reads back; a local id is not one', () => {
    const key = remoteSessionKey('rt_1', 's1')
    expect(sessionTab(key)).toBe('session:rt_1:s1')
    expect(parseTab(sessionTab(key))).toEqual({ kind: 'session', id: 'rt_1:s1' })
    expect(parseRemoteSessionKey(key)).toEqual({ runtimeId: 'rt_1', sessionId: 's1' })
    expect(isRemoteSessionKey(key)).toBe(true)
    expect(parseRemoteSessionKey('5f0c2a1e-1111-4222-8333-944445555666')).toBeNull()
    expect(isRemoteSessionKey('term_1')).toBe(false)
    expect(parseRemoteSessionKey(':s1')).toBeNull()
    expect(parseRemoteSessionKey('rt_1:')).toBeNull()
  })
})

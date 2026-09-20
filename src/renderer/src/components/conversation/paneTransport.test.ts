import { describe, it, expect } from 'vitest'
import { composerLockedFor, chatBannerFor } from './paneTransport'
import type { ChatState } from '../../../../core/chat/types'

const base: ChatState = { status: 'idle', request: null, model: { model: null, effort: null, permissionMode: 'default' }, error: null, exitCode: null, errorDetail: null, outlivesApp: true, truncated: false, provider: 'codex' }
const approval = { id: '0', kind: 'approval' as const, about: { tool: 'shell', lines: ['ls'] }, decisions: ['accept' as const, 'decline' as const] }

describe('composerLockedFor', () => {
  it('a terminal pane keeps its own rule', () => {
    expect(composerLockedFor({ kind: 'terminal' }, null, true)).toBe(true)
    expect(composerLockedFor({ kind: 'terminal' }, null, false)).toBe(false)
  })
  it('a chat pane is shut before the state is known and while a request is up', () => {
    expect(composerLockedFor({ kind: 'chat' }, null, false)).toBe(true)
    expect(composerLockedFor({ kind: 'chat' }, base, false)).toBe(false)
    expect(composerLockedFor({ kind: 'chat' }, { ...base, request: approval }, false)).toBe(true)
    expect(composerLockedFor({ kind: 'chat' }, { ...base, status: 'working' }, false)).toBe(false)
  })
})

describe('chatBannerFor', () => {
  it('the request wins, then the error, then the notices, else nothing', () => {
    expect(chatBannerFor(null)).toEqual({ kind: 'none' })
    expect(chatBannerFor({ ...base, request: approval, error: 'x' })).toEqual({ kind: 'request', request: approval })
    expect(chatBannerFor({ ...base, error: 'rate limited' })).toEqual({ kind: 'error', message: 'rate limited' })
    expect(chatBannerFor({ ...base, truncated: true })).toEqual({ kind: 'checking' })
    expect(chatBannerFor({ ...base, truncated: true, status: 'working' })).toEqual({ kind: 'none' })
    expect(chatBannerFor({ ...base, outlivesApp: false })).toEqual({ kind: 'endsWithApp' })
    expect(chatBannerFor(base)).toEqual({ kind: 'none' })
  })

  // Task 7 (design F5): request·error 다음, checking·endsWithApp 보다는 앞 — 새 소식이라 조용한
  // 상태 둘보다는 앞서지만, 지금 답해야 하는 request·error 보다는 뒤다.
  it('우회 알림은 request·error 다음, checking·endsWithApp 보다는 앞이다', () => {
    expect(chatBannerFor({ ...base, notice: 'bypassed' })).toEqual({ kind: 'notice', key: 'bypassed' })
    expect(chatBannerFor({ ...base, notice: 'bypassed', error: 'rate limited' })).toEqual({
      kind: 'error',
      message: 'rate limited'
    })
    expect(chatBannerFor({ ...base, notice: 'bypassed', truncated: true })).toEqual({ kind: 'notice', key: 'bypassed' })
    expect(chatBannerFor({ ...base, notice: 'bypassed', outlivesApp: false })).toEqual({ kind: 'notice', key: 'bypassed' })
  })
})

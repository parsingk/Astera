// The watch hands a remote session's tab a fresh ref when its Runtime's row says something new about it (Phase 9b).
import { describe, it, expect } from 'vitest'
import { sameRef } from './useRemoteSessionWatch'
import { refOf } from '../lib/remoteSessions'

const row = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  kind: 'terminal' as const,
  title: 'fix',
  accountId: 'acc',
  cwd: '/srv/repo',
  alive: true,
  state: 'unknown',
  ptyId: 'pty-1',
  provider: 'codex' as const,
  ...over
})

describe('sameRef', () => {
  it('is the same ref while the row says nothing new', () => {
    expect(sameRef(refOf('rt_1', row()), refOf('rt_1', row()))).toBe(true)
    expect(sameRef(refOf('rt_1', row()), refOf('rt_1', row({ alive: false })))).toBe(false)
  })

  // Sandbox follow-ups, round 2: a tab opened from a ref made before the ref carried the sandbox (or from an older
  // Runtime) takes the marker at the next look
  it('is a new ref once the row says the session is sandboxed, or how', () => {
    expect(sameRef(refOf('rt_1', row()), refOf('rt_1', row({ sandboxed: true, sandboxKind: 'sandbox' })))).toBe(false)
    expect(sameRef(refOf('rt_1', row({ sandboxed: true, sandboxKind: 'sandbox' })), refOf('rt_1', row({ sandboxed: true, sandboxKind: 'deny-only' })))).toBe(false)
    expect(sameRef(refOf('rt_1', row({ sandboxed: true, sandboxKind: 'sandbox' })), refOf('rt_1', row({ sandboxed: true, sandboxKind: 'sandbox' })))).toBe(true)
  })
})

import { describe, it, expect } from 'vitest'
import { foldChatEvent } from './useChatState'
import type { ChatState } from '../../../core/chat/types'

const base: ChatState = {
  status: 'idle',
  request: null,
  model: { model: null, effort: null, permissionMode: 'default' },
  error: null,
  outlivesApp: true,
  truncated: true,
  provider: 'codex'
}

describe('foldChatEvent', () => {
  it('a status event carrying truncated ends the guess; one without it leaves the flag alone', () => {
    expect(foldChatEvent(base, { type: 'status', status: 'working', truncated: false })).toMatchObject({
      status: 'working',
      truncated: false
    })
    expect(foldChatEvent(base, { type: 'status', status: 'working' }).truncated).toBe(true)
  })
  it('a turn starting still clears the previous turn’s error', () => {
    const failed = { ...base, error: 'rate limited' }
    expect(foldChatEvent(failed, { type: 'status', status: 'working', truncated: false }).error).toBeNull()
    expect(foldChatEvent(failed, { type: 'status', status: 'idle', truncated: false }).error).toBe('rate limited')
  })
})

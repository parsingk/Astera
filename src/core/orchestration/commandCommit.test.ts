import { describe, it, expect, vi, afterEach } from 'vitest'

// **What pins commit()'s rule, not the words state.ts happens to use** (R4). Every `gone` refusal
// state.ts has today begins `unknown `, and every unmarked one a command reaches through commit()
// does not, so the old prefix test and the `missing` mark give the same answers on the real pure
// layer: reverting commit() to `startsWith('unknown ')` passed the whole suite. Here the pure layer's
// answer is replaced (applyReply, which `reply` hands straight to commit()) with the two refusals on
// which the rules disagree.
const replyResult = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('./state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./state')>()
  return {
    ...actual,
    applyReply: (...args: Parameters<typeof actual.applyReply>) =>
      replyResult.current ?? actual.applyReply(...args)
  }
})

import { handleCommand, type OrchServerDeps } from './command'
import { emptyState, type OrchState } from './state'

const makeDeps = (): OrchServerDeps => {
  const box = { state: emptyState() as OrchState }
  return {
    getState: () => box.state,
    setState: async (next) => {
      box.state = next
    },
    startWorker: async () => ({ sessionId: 'sess1', cwd: 'D:/p', specPath: 'D:/p/orch/specs/a.md' }),
    releaseWorker: async () => {},
    listAccounts: () => [],
    readWorker: async () => '',
    now: () => '2026-09-25T00:00:00.000Z'
  } as OrchServerDeps
}

afterEach(() => {
  replyResult.current = null
})

describe('commit() — 404 는 missing 표시로만 난다, 문구가 아니라 (R4)', () => {
  it('missing 이 붙은 거절은 "unknown " 으로 시작하지 않아도 404 다', async () => {
    replyResult.current = { ok: false, error: 'no such message: msg_x', missing: true }
    const r = await handleCommand(makeDeps(), { sessionId: 'coordinator' }, 'reply', { id: 'msg_x', body: 'b' })
    expect(r).toEqual({ status: 404, body: { error: 'no such message: msg_x' } })
  })

  it('missing 이 없는 거절은 "unknown " 으로 시작해도 400 이다', async () => {
    replyResult.current = { ok: false, error: 'unknown question: msg_x' }
    const r = await handleCommand(makeDeps(), { sessionId: 'coordinator' }, 'reply', { id: 'msg_x', body: 'b' })
    expect(r).toEqual({ status: 400, body: { error: 'unknown question: msg_x' } })
  })
})

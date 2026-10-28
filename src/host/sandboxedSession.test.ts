// Final fix pass (C3): the Host reads whether a caller's session runs in the sandbox from the note its manager wrote.
import { describe, it, expect } from 'vitest'
import { PtyRegistry, type RegistryPty } from './registry'
import { ProcRegistry, type RegistryProc } from './procRegistry'
import { sessionSandboxedIn } from './sandboxedSession'

const fakePty = (): RegistryPty => ({ pid: 1, onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {}, pause: () => {}, resume: () => {} })
const fakeProc = (): RegistryProc => ({ pid: 2, onData: () => {}, onExit: () => {}, write: () => {}, kill: () => {} })

describe('sessionSandboxedIn', () => {
  it('reads the mark off a live terminal’s or chat’s note, and answers false for a session not held', () => {
    const ptys = new PtyRegistry({ spawn: () => fakePty(), log: () => {} })
    const procs = new ProcRegistry({ spawn: () => fakeProc(), log: () => {} })
    const opts = { cwd: 'D:/p', cols: 80, rows: 24, env: {} }
    ptys.open({ id: 'p1', file: 'codex', args: [], opts, meta: { kind: 'session', id: 'ses_box', restore: { sandboxed: true, sandboxKind: 'sandbox' } } })
    ptys.open({ id: 'p2', file: 'codex', args: [], opts, meta: { kind: 'session', id: 'ses_open', restore: {} } })
    procs.open({ id: 'q1', file: 'codex', args: ['app-server'], opts: { cwd: 'D:/p', env: {} }, meta: { kind: 'chat', id: 'chat_box', restore: { sandboxed: true } } })
    procs.open({ id: 'q2', file: 'codex', args: ['app-server'], opts: { cwd: 'D:/p', env: {} }, meta: { kind: 'chat', id: 'chat_open', restore: {} } })
    const asked = (id: string) => sessionSandboxedIn({ ptys, procs }, id)
    expect(asked('ses_box')).toBe(true)
    expect(asked('chat_box')).toBe(true)
    expect(asked('ses_open')).toBe(false)
    expect(asked('chat_open')).toBe(false)
    expect(asked('ses_gone')).toBe(false)
  })
})

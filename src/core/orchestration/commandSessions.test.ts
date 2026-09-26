// `sessions create` (CLI spec §14): a terminal or chat session started by the Host, through the spawn
// path the app and the Host already use. This file holds the command layer's half: what it refuses
// before anything is started, and what it hands the Host's starter (`createSession`).
import { describe, it, expect, vi } from 'vitest'
import { handleCommand, type HostSession, type OrchServerDeps } from './command'
import { emptyState, type OrchState } from './state'

const NOW = '2026-09-26T00:00:00.000Z'

const row = (over: Partial<HostSession> = {}): HostSession => ({
  id: 'sess_new',
  kind: 'terminal',
  title: 't',
  accountId: 'acc_c',
  cwd: 'D:/p',
  alive: true,
  state: 'unknown',
  ...over
})

const makeDeps = (extra: Partial<OrchServerDeps> = {}): OrchServerDeps => {
  const box = { state: emptyState() }
  return {
    getState: () => box.state,
    setState: async (next: OrchState) => {
      box.state = next
    },
    startWorker: async () => ({ sessionId: 's', cwd: 'D:/p', specPath: 'S' }),
    releaseWorker: async () => {},
    listAccounts: (provider?: 'claude' | 'codex') =>
      [
        { id: 'acc_c', label: 'C', provider: 'claude' as const },
        { id: 'acc_c2', label: 'C2', provider: 'claude' as const },
        { id: 'acc_x', label: 'X', provider: 'codex' as const }
      ].filter((a) => provider === undefined || a.provider === provider),
    readWorker: async () => '',
    now: () => NOW,
    ...extra
  } as OrchServerDeps
}

const call = (deps: OrchServerDeps, args: Record<string, unknown>) =>
  handleCommand(deps, { sessionId: '' }, 'sessions-create', args)

const error = (r: { body: unknown }): string => (r.body as { error: string }).error

describe('sessions create — what reaches the Host starter', () => {
  it('a terminal session by default, with the account at the head of its chain', async () => {
    const createSession = vi.fn(async () => row())
    const r = await call(makeDeps({ createSession }), { account: 'acc_c', cwd: 'D:/p', title: 'fix', prompt: 'run the tests' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual(row())
    expect(createSession).toHaveBeenCalledWith({
      kind: 'terminal',
      accountId: 'acc_c',
      cwd: 'D:/p',
      title: 'fix',
      prompt: 'run the tests',
      rollAccountIds: []
    })
  })

  it('--roll-accounts is the chain to roll onto, --account first even when it is not listed', async () => {
    const createSession = vi.fn(async () => row())
    await call(makeDeps({ createSession }), { account: 'acc_c', cwd: 'D:/p', rollAccounts: 'acc_c2' })
    expect(createSession).toHaveBeenLastCalledWith(expect.objectContaining({ rollAccountIds: ['acc_c', 'acc_c2'] }))
    await call(makeDeps({ createSession }), { account: 'acc_c', cwd: 'D:/p', rollAccounts: 'acc_c2,acc_c' })
    expect(createSession).toHaveBeenLastCalledWith(expect.objectContaining({ rollAccountIds: ['acc_c2', 'acc_c'] }))
  })

  it('a chat session takes --unattended, and hold is the default', async () => {
    const createSession = vi.fn(async () => row({ kind: 'chat' }))
    await call(makeDeps({ createSession }), { account: 'acc_c', cwd: 'D:/p', kind: 'chat' })
    expect(createSession).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'chat', unattended: 'hold' }))
    await call(makeDeps({ createSession }), { account: 'acc_c', cwd: 'D:/p', kind: 'chat', unattended: 'deny-after-60s' })
    expect(createSession).toHaveBeenLastCalledWith(expect.objectContaining({ unattended: 'deny-after-60s' }))
  })
})

describe('sessions create — refused before anything starts', () => {
  const refused = async (args: Record<string, unknown>, status: number, contains: string): Promise<void> => {
    const createSession = vi.fn(async () => row())
    const r = await call(makeDeps({ createSession }), args)
    expect(r.status, JSON.stringify(args)).toBe(status)
    expect(error(r), JSON.stringify(args)).toContain(contains)
    expect(createSession).not.toHaveBeenCalled()
  }

  it('needs --account and --cwd (2)', async () => {
    await refused({ cwd: 'D:/p' }, 400, '--account')
    await refused({ account: 'acc_c' }, 400, '--cwd')
    await refused({ account: true, cwd: 'D:/p' }, 400, '--account')
  })

  it('an account that is not there is 4', async () => {
    await refused({ account: 'acc_gone', cwd: 'D:/p' }, 404, 'acc_gone')
    await refused({ account: 'acc_c', cwd: 'D:/p', rollAccounts: 'acc_gone' }, 404, 'acc_gone')
  })

  it('an unknown --kind or --unattended is 2, naming what it takes', async () => {
    await refused({ account: 'acc_c', cwd: 'D:/p', kind: 'pty' }, 400, 'terminal')
    await refused({ account: 'acc_c', cwd: 'D:/p', kind: 'chat', unattended: 'allow' }, 400, 'deny-after-60s')
  })

  it('--unattended belongs to chat sessions (2)', async () => {
    await refused({ account: 'acc_c', cwd: 'D:/p', unattended: 'hold' }, 400, 'chat')
  })

  it('a chain that mixes vendors is 2', async () => {
    await refused({ account: 'acc_c', cwd: 'D:/p', rollAccounts: 'acc_x' }, 400, 'mix')
  })

  it('an empty --prompt or --title is 2, not a session with nothing', async () => {
    await refused({ account: 'acc_c', cwd: 'D:/p', prompt: true }, 400, '--prompt')
    await refused({ account: 'acc_c', cwd: 'D:/p', title: true }, 400, '--title')
  })

  it('a caller that is not the Host is 6', async () => {
    const r = await call(makeDeps(), { account: 'acc_c', cwd: 'D:/p' })
    expect(r.status).toBe(409)
    expect(error(r)).toContain('Host')
  })

  it('a start that fails is 2 with its reason', async () => {
    const createSession = vi.fn(async () => {
      throw new Error('CWD_MISSING: D:/nope')
    })
    const r = await call(makeDeps({ createSession }), { account: 'acc_c', cwd: 'D:/nope' })
    expect(r.status).toBe(400)
    expect(error(r)).toContain('CWD_MISSING')
  })
})

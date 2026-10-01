// `sessions create` (CLI spec §14): a terminal or chat session started by the Host, through the spawn
// path the app and the Host already use. This file holds the command layer's half: what it refuses
// before anything is started, and what it hands the Host's starter (`createSession`).
import { describe, it, expect, vi } from 'vitest'
import { handleCommand, type HostSession, type OrchServerDeps } from './command'
import { emptyState, type OrchState } from './state'
import { APP_CALLER, HOST_CALLER } from '../host/driver'

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

  // Security review 2026-09-28: a terminal session's prompt is a command-line argument, and on win32
  // the launch goes through cmd.exe — `--prompt "hi|calc.exe"` ran calc.exe from the Host. The
  // worker launch has refused these characters from the start; this call did not.
  it('a terminal prompt with cmd.exe syntax is 2, before anything starts', async () => {
    for (const prompt of ['hi|calc.exe', 'hi&calc.exe', 'say "hi"', 'a%PATH%b', 'two\nlines', 'x<y', 'x>y', 'x^y'])
      await refused({ account: 'acc_c', cwd: 'D:/p', prompt }, 400, 'command line')
  })

  it('a chat prompt goes over stdio and is not checked', async () => {
    const createSession = vi.fn(async () => row())
    const r = await call(makeDeps({ createSession }), { account: 'acc_c', cwd: 'D:/p', kind: 'chat', prompt: 'hi|there & "you"' })
    expect(r.status).toBe(200)
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'hi|there & "you"' }))
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

// `sessions send --wait` (CLI spec §15): after the send is accepted, the Host waits until the session's
// turn ends, reading what it already knows: the hook-event state of a terminal session, the adapter's
// status of a chat session. The ending rides `turn`; the CLI turns it into the exit code.
describe('sessions send --wait — the turn after the send', () => {
  const terminal: HostSession = { id: 't1', kind: 'terminal', title: 't', accountId: 'acc_c', cwd: 'D:/p', alive: true, state: 'waiting' }
  const codexTerminal: HostSession = { ...terminal, id: 't2', accountId: 'acc_x' }
  const chat: HostSession = { ...terminal, id: 'c1', kind: 'chat', state: 'unknown' }
  type Turn = { alive: boolean; state: 'working' | 'waiting' | 'unknown'; prompt: 'permission' | 'question' | null }
  type ChatTurnState = { alive: boolean; status: 'idle' | 'working' | 'waiting'; error: string | null; prompt: unknown }

  const hostDeps = (a: { turns?: Turn[]; chatTurns?: Array<ChatTurnState | undefined> } = {}) => {
    const turns = [...(a.turns ?? [])]
    const chatTurns = [...(a.chatTurns ?? [])]
    const sendSession = vi.fn(async () => {})
    const chatSend = vi.fn(async () => ({ sent: true as const }))
    const sessionTurn = vi.fn(async () => (turns.length > 1 ? turns.shift()! : turns[0]))
    const chatTurn = vi.fn(async () => (chatTurns.length > 1 ? chatTurns.shift() : chatTurns[0]))
    const deps = makeDeps({
      listSessions: async () => [terminal, codexTerminal, chat],
      readSession: async () => ({ cols: 80, rows: 24, screen: [], scrollback: [] }),
      sendSession,
      readChat: async () => [],
      chatSend,
      sessionTurn,
      chatTurn
    } as Partial<OrchServerDeps>)
    return { deps, sendSession, chatSend, sessionTurn, chatTurn }
  }
  const send = (deps: OrchServerDeps, args: Record<string, unknown>) =>
    handleCommand(deps, { sessionId: '' }, 'sessions-send', args)
  const turnOf = (r: { body: unknown }): Record<string, unknown> => (r.body as { turn: Record<string, unknown> }).turn

  it('a terminal turn ends when its hook state reaches waiting with no prompt', async () => {
    const h = hostDeps({
      turns: [
        { alive: true, state: 'unknown', prompt: null },
        { alive: true, state: 'working', prompt: null },
        { alive: true, state: 'waiting', prompt: null }
      ]
    })
    const r = await send(h.deps, { id: 't1', text: 'run the tests', wait: true })
    expect(r.status).toBe(200)
    expect(h.sendSession).toHaveBeenCalledTimes(1)
    expect(r.body).toMatchObject({ id: 't1', sent: true, enter: true })
    expect(turnOf(r)).toEqual({ state: 'ended' })
    // The stamp the Host compares events against is when this send began.
    expect(h.sessionTurn).toHaveBeenCalledWith('t1', expect.any(Number))
  })

  it('a permission prompt that opens during the wait ends it, saying which kind', async () => {
    const h = hostDeps({
      turns: [
        { alive: true, state: 'unknown', prompt: null },
        { alive: true, state: 'working', prompt: null },
        { alive: true, state: 'waiting', prompt: 'permission' }
      ]
    })
    const r = await send(h.deps, { id: 't1', text: 'go', wait: true })
    expect(turnOf(r)).toEqual({ state: 'prompt', prompt: { kind: 'permission' } })
  })

  it('a session that ends during the wait, and a deadline that passes first', async () => {
    const exited = hostDeps({ turns: [{ alive: false, state: 'unknown', prompt: null }] })
    expect(turnOf(await send(exited.deps, { id: 't1', text: 'go', wait: true }))).toEqual({ state: 'exited' })
    // The first read is the check before the send (review 3, I2); the turn then stays working.
    const slow = hostDeps({ turns: [{ alive: true, state: 'waiting', prompt: null }, { alive: true, state: 'working', prompt: null }] })
    expect(turnOf(await send(slow.deps, { id: 't1', text: 'go', wait: true, timeoutMs: 30 }))).toEqual({ state: 'timeout' })
  })

  it('a Codex terminal session writes no hook events, so the wait is refused before anything is typed (6)', async () => {
    const h = hostDeps({ turns: [{ alive: true, state: 'unknown', prompt: null }] })
    const r = await send(h.deps, { id: 't2', text: 'go', wait: true })
    expect(r.status).toBe(409)
    expect(error(r)).toContain('Codex')
    expect(h.sendSession).not.toHaveBeenCalled()
  })

  it('--no-enter starts no turn, so it cannot be waited for (2)', async () => {
    const h = hostDeps({ turns: [{ alive: true, state: 'waiting', prompt: null }] })
    expect((await send(h.deps, { id: 't1', text: 'go', wait: true, noEnter: true })).status).toBe(400)
    expect(h.sendSession).not.toHaveBeenCalled()
  })

  it('a chat turn ends when the adapter goes back to idle', async () => {
    const idle: ChatTurnState = { alive: true, status: 'idle', error: null, prompt: null }
    const h = hostDeps({ chatTurns: [idle, { ...idle, status: 'working' }, idle] })
    const r = await send(h.deps, { id: 'c1', text: 'hello', wait: true })
    expect(r.status).toBe(200)
    expect(h.chatSend).toHaveBeenCalledTimes(1)
    expect(turnOf(r)).toEqual({ state: 'ended' })
  })

  it('a chat permission prompt ends the wait with its prompt id', async () => {
    const idle: ChatTurnState = { alive: true, status: 'idle', error: null, prompt: null }
    const prompt = { sessionId: 'c1', id: 'req_7', kind: 'approval', tool: 'Bash', summary: 'npm test' }
    const h = hostDeps({ chatTurns: [idle, { ...idle, status: 'working' }, { ...idle, status: 'waiting', prompt }] })
    const r = await send(h.deps, { id: 'c1', text: 'hello', wait: true })
    expect(turnOf(r)).toEqual({
      state: 'prompt',
      promptId: 'req_7',
      prompt: { kind: 'approval', tool: 'Bash', summary: 'npm test' }
    })
  })

  it('a chat turn that failed still ended, and says why', async () => {
    const idle: ChatTurnState = { alive: true, status: 'idle', error: null, prompt: null }
    const h = hostDeps({ chatTurns: [idle, { ...idle, status: 'working' }, { ...idle, error: 'the API answered 500' }] })
    expect(turnOf(await send(h.deps, { id: 'c1', text: 'hello', wait: true }))).toEqual({
      state: 'ended',
      error: 'the API answered 500'
    })
  })

  it('a chat session nobody can read the status of is refused before the send (6)', async () => {
    const h = hostDeps({ chatTurns: [undefined] })
    const r = await send(h.deps, { id: 'c1', text: 'hello', wait: true })
    expect(r.status).toBe(409)
    expect(h.chatSend).not.toHaveBeenCalled()
  })

  it('an observed replay waits again without sending again', async () => {
    const h = hostDeps({ turns: [{ alive: true, state: 'waiting', prompt: null }] })
    const r = await send(h.deps, { id: 't1', text: 'go', wait: true, resumeWait: true })
    expect(turnOf(r)).toEqual({ state: 'ended' })
    expect(h.sendSession).not.toHaveBeenCalled()
  })

  it('without --wait nothing is waited for and there is no turn', async () => {
    const h = hostDeps({ turns: [{ alive: true, state: 'working', prompt: null }] })
    const r = await send(h.deps, { id: 't1', text: 'go' })
    expect(r.body).toEqual({ id: 't1', sent: true, enter: true })
    expect(h.sessionTurn).not.toHaveBeenCalled()
  })
})

// Review 3, I1 and I2: a wait must not end on a turn that is not the one the send started.
describe('sessions send --wait — the turn it ends on is the one it started', () => {
  const terminal: HostSession = { id: 't1', kind: 'terminal', title: 't', accountId: 'acc_c', cwd: 'D:/p', alive: true, state: 'waiting' }
  const chat: HostSession = { ...terminal, id: 'c1', kind: 'chat', state: 'unknown' }
  type ChatTurnState = { alive: boolean; status: 'idle' | 'working' | 'waiting'; error: string | null; prompt: unknown }
  const idle: ChatTurnState = { alive: true, status: 'idle', error: null, prompt: null }
  const rig = (a: { turns?: Array<{ alive: boolean; state: 'working' | 'waiting' | 'unknown'; prompt: null }>; chatTurns?: ChatTurnState[] }) => {
    const turns = [...(a.turns ?? [])]
    const chatTurns = [...(a.chatTurns ?? [])]
    const sendSession = vi.fn(async () => {})
    const chatSend = vi.fn(async () => ({ sent: true as const }))
    const deps = makeDeps({
      listSessions: async () => [terminal, chat],
      sendSession,
      chatSend,
      sessionTurn: vi.fn(async () => (turns.length > 1 ? turns.shift()! : turns[0])),
      chatTurn: vi.fn(async () => (chatTurns.length > 1 ? chatTurns.shift() : chatTurns[0]))
    } as Partial<OrchServerDeps>)
    return { deps, sendSession, chatSend }
  }
  const send = (deps: OrchServerDeps, args: Record<string, unknown>) => handleCommand(deps, { sessionId: '' }, 'sessions-send', args)

  it('a chat idle read before the turn is seen working does not end the wait', async () => {
    // pre-check idle, then two idles (a reader that has not heard the turn yet), then working, then idle.
    const h = rig({ chatTurns: [idle, idle, idle, { ...idle, status: 'working' }, idle] })
    const r = await send(h.deps, { id: 'c1', text: 'hello', wait: true })
    expect((r.body as { turn: unknown }).turn).toEqual({ state: 'ended' })
    expect(h.chatSend).toHaveBeenCalledTimes(1)
  })

  it('a chat turn never seen working runs to the deadline rather than ending at once', async () => {
    const h = rig({ chatTurns: [idle] })
    const r = await send(h.deps, { id: 'c1', text: 'hello', wait: true, timeoutMs: 600 })
    expect((r.body as { turn: unknown }).turn).toEqual({ state: 'timeout' })
  })

  it('a terminal session still in a turn is refused before anything is typed (6)', async () => {
    const h = rig({ turns: [{ alive: true, state: 'working', prompt: null }] })
    const r = await send(h.deps, { id: 't1', text: 'go', wait: true })
    expect(r.status).toBe(409)
    expect(error(r)).toContain('busy')
    expect(h.sendSession).not.toHaveBeenCalled()
  })

  it('a busy terminal still takes a send without --wait', async () => {
    const h = rig({ turns: [{ alive: true, state: 'working', prompt: null }] })
    expect((await send(h.deps, { id: 't1', text: 'go' })).status).toBe(200)
    expect(h.sendSession).toHaveBeenCalledTimes(1)
  })
})

// Controller ruling on review 3, I3: a worker cannot start a session, which would run outside its role.
describe('sessions create — refused to a worker session', () => {
  it('a caller with an open Dispatch is 5; the shell, a plain session and a coordinator are not', async () => {
    const createSession = vi.fn(async () => row())
    const deps = makeDeps({ createSession, startWorker: async () => ({ sessionId: 'sess_w', cwd: 'D:/p', specPath: 'S' }) })
    await handleCommand(deps, { sessionId: '' }, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const runId = deps.getState().runs.at(-1)!.id
    const t = await handleCommand(deps, { sessionId: '' }, 'task-create', { run: runId, title: 't', spec: 's', account: 'acc_c' })
    await handleCommand(deps, { sessionId: '' }, 'worker-start', { task: (t.body as { id: string }).id, agent: 'claude', account: 'acc_c', worktree: 'current' })
    const worker = await handleCommand(deps, { sessionId: 'sess_w' }, 'sessions-create', { account: 'acc_c', cwd: 'D:/p' })
    expect(worker.status).toBe(403)
    expect(createSession).not.toHaveBeenCalled()
    for (const sessionId of ['', 'sess_plain'])
      expect((await handleCommand(deps, { sessionId }, 'sessions-create', { account: 'acc_c', cwd: 'D:/p' })).status, sessionId).toBe(200)
    // sessions send stays open to the worker.
  })
})

// Security review 2026-09-28, the accident guard: text an agent sends into a terminal session that is
// holding a permission prompt or a question answers it (orchestration-guide.md says so and tells agents
// not to). A send from inside an agent session is now refused there, before anything is typed, the way a
// chat session's open card already refuses one. It is not a boundary — an agent that clears
// ASTERA_SESSION reads as a shell, as with every role check in this CLI (docs/cli.md) — it keeps an
// agent, or text injected into one, from answering by accident. The person, the app and the Host still can.
describe('sessions send — an agent does not answer another session\'s prompt', () => {
  const terminal: HostSession = { id: 't1', kind: 'terminal', title: 't', accountId: 'acc_c', cwd: 'D:/p', alive: true, state: 'waiting' }
  type Turn = { alive: boolean; state: 'working' | 'waiting' | 'unknown'; prompt: 'permission' | 'question' | null }
  const rig = (turn: Turn) => {
    const sendSession = vi.fn(async () => {})
    const deps = makeDeps({
      listSessions: async () => [terminal],
      readSession: async () => ({ cols: 80, rows: 24, screen: [], scrollback: [] }),
      sendSession,
      readChat: async () => [],
      chatSend: vi.fn(async () => ({ sent: true as const })),
      sessionTurn: vi.fn(async () => turn)
    } as Partial<OrchServerDeps>)
    return { deps, sendSession }
  }
  const send = (deps: OrchServerDeps, sessionId: string) =>
    handleCommand(deps, { sessionId }, 'sessions-send', { id: 't1', text: '1' })

  it('refuses an agent session\'s send into a terminal session at a permission prompt or a question, typing nothing', async () => {
    for (const prompt of ['permission', 'question'] as const) {
      const h = rig({ alive: true, state: 'waiting', prompt })
      const r = await send(h.deps, 'sess_agent')
      expect(r.status, prompt).toBe(409)
      expect(error(r), prompt).toContain(`sessions read --id t1`)
      expect(h.sendSession, prompt).not.toHaveBeenCalled()
    }
  })

  it('lets the person (a shell), the app and the Host answer it', async () => {
    for (const sessionId of ['', APP_CALLER, HOST_CALLER]) {
      const h = rig({ alive: true, state: 'waiting', prompt: 'permission' })
      expect((await send(h.deps, sessionId)).status, sessionId).toBe(200)
      expect(h.sendSession, sessionId).toHaveBeenCalledTimes(1)
    }
  })

  it('still lets an agent send into a session at its own input prompt, or one whose state is not known', async () => {
    for (const turn of [
      { alive: true, state: 'waiting', prompt: null },
      { alive: true, state: 'unknown', prompt: null },
      { alive: true, state: 'working', prompt: null }
    ] as Turn[]) {
      const h = rig(turn)
      expect((await send(h.deps, 'sess_agent')).status, JSON.stringify(turn)).toBe(200)
      expect(h.sendSession).toHaveBeenCalledTimes(1)
    }
  })
})

// MCP P1 design §2 (Q4): an MCP client calls with an empty session id, which reads as a shell, so it
// passed the agent guard above. Its text would answer the prompt as surely as an agent's, so role mcp
// is refused the same way. The CLI from a shell (role cli, empty session id) still answers.
describe('sessions send — an MCP client does not answer a session\'s prompt', () => {
  const terminal: HostSession = { id: 't1', kind: 'terminal', title: 't', accountId: 'acc_c', cwd: 'D:/p', alive: true, state: 'waiting' }
  const rig = (prompt: 'permission' | 'question') => {
    const sendSession = vi.fn(async () => {})
    const deps = makeDeps({
      listSessions: async () => [terminal],
      readSession: async () => ({ cols: 80, rows: 24, screen: [], scrollback: [] }),
      sendSession,
      readChat: async () => [],
      chatSend: vi.fn(async () => ({ sent: true as const })),
      sessionTurn: vi.fn(async () => ({ alive: true, state: 'waiting' as const, prompt }))
    } as Partial<OrchServerDeps>)
    return { deps, sendSession }
  }

  it('refuses role mcp at a permission prompt or a question, naming it and typing nothing (6)', async () => {
    for (const [prompt, words] of [
      ['permission', 'a permission prompt'],
      ['question', 'a question']
    ] as const) {
      const h = rig(prompt)
      const r = await handleCommand(h.deps, { sessionId: '', role: 'mcp' }, 'sessions-send', { id: 't1', text: '1' })
      expect(r.status, prompt).toBe(409)
      expect(error(r), prompt).toContain(`waiting on ${words}`)
      expect(error(r), prompt).toContain('an MCP client')
      expect(h.sendSession, prompt).not.toHaveBeenCalled()
    }
  })

  it('still lets the CLI from a shell answer it', async () => {
    const h = rig('permission')
    const r = await handleCommand(h.deps, { sessionId: '', role: 'cli' }, 'sessions-send', { id: 't1', text: '1' })
    expect(r.status).toBe(200)
    expect(h.sendSession).toHaveBeenCalledTimes(1)
  })
})

// MCP P1 design §2 (Q5): an MCP client starts a session only in a registered project's root, never an
// arbitrary folder (MCP spec §68). The CLI keeps any --cwd.
describe('sessions create — an MCP client starts sessions only in a project', () => {
  const withProjects = async (createSession: OrchServerDeps['createSession']): Promise<OrchServerDeps> => {
    const deps = makeDeps({ createSession })
    await deps.setState({
      ...deps.getState(),
      projects: [
        { id: 'prj_a', path: 'D:/work/repo', name: 'repo', addedAt: NOW },
        { id: 'prj_gone', path: 'D:/work/gone', name: 'gone', addedAt: NOW }
      ]
    })
    return deps
  }
  const mcp = (deps: OrchServerDeps, cwd: string) =>
    handleCommand(deps, { sessionId: '', role: 'mcp' }, 'sessions-create', { account: 'acc_c', cwd })

  it('refuses a folder that is no project root, or only inside one (5), starting nothing', async () => {
    const createSession = vi.fn(async () => row())
    const deps = await withProjects(createSession)
    for (const cwd of ['D:/elsewhere', 'D:/work/repo/sub', 'D:/work']) {
      const r = await mcp(deps, cwd)
      expect(r.status, cwd).toBe(403)
      expect(error(r), cwd).toContain('MCP clients start sessions only in a registered project')
    }
    expect(createSession).not.toHaveBeenCalled()
  })

  it('takes a project root, compared with isSamePath (a trailing separator is the same root)', async () => {
    const createSession = vi.fn(async () => row())
    const deps = await withProjects(createSession)
    expect((await mcp(deps, 'D:/work/repo')).status).toBe(200)
    expect((await mcp(deps, 'D:/work/repo/')).status).toBe(200)
    expect(createSession).toHaveBeenCalledTimes(2)
  })

  // Review Focus 2: a project whose folder was moved or deleted after it was registered. The starter
  // probes the folder before any spawn (host/sessionCreate.ts, spawner.ts: CWD_MISSING), and that
  // refusal comes back as a 2, not a session in a missing folder.
  it('a project root whose folder is gone is the starter\'s CWD_MISSING refusal (2)', async () => {
    const createSession = vi.fn(async (o: { cwd: string }) => {
      throw new Error(`CWD_MISSING: ${o.cwd} does not exist`)
    })
    const deps = await withProjects(createSession as unknown as OrchServerDeps['createSession'])
    const r = await mcp(deps, 'D:/work/gone')
    expect(r.status).toBe(400)
    expect(error(r)).toContain('CWD_MISSING: D:/work/gone does not exist')
  })

  it('the CLI keeps any --cwd', async () => {
    const createSession = vi.fn(async () => row())
    const deps = await withProjects(createSession)
    const r = await handleCommand(deps, { sessionId: '', role: 'cli' }, 'sessions-create', { account: 'acc_c', cwd: 'D:/elsewhere' })
    expect(r.status).toBe(200)
    expect(createSession).toHaveBeenCalledTimes(1)
  })
})

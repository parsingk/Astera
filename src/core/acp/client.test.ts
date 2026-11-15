import { describe, it, expect, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { nodeProcFactory } from '../sessions/nodeProcFactory'
import type { ProcLike } from '../sessions/proc'
import { openAcpSession, AcpFailure, type AcpSession } from './client'

const FAKE = fileURLToPath(new URL('./__fixtures__/fakeAgent.mjs', import.meta.url))

// 20 s: a real child process on a loaded machine.
const until = <T>(check: () => T | undefined, ms = 20_000): Promise<T> =>
  new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = (): void => {
      const v = check()
      if (v !== undefined) return resolve(v)
      if (Date.now() - t0 > ms) return reject(new Error('timed out'))
      setTimeout(tick, 20)
    }
    tick()
  })
const bounded = <T>(p: Promise<T>, ms = 20_000): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))])
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const failureOf = async (p: Promise<unknown>): Promise<AcpFailure> => {
  const e = await bounded(p.then(() => null, (x: unknown) => x))
  expect(e).toBeInstanceOf(AcpFailure)
  return e as AcpFailure
}

const spawned: ProcLike[] = []
const sessions: AcpSession[] = []
afterEach(() => {
  for (const s of sessions.splice(0)) s.close()
  for (const p of spawned.splice(0)) p.kill()
})

function launch(mode: string, extra: string[] = []): ProcLike {
  const proc = nodeProcFactory(process.execPath, [FAKE, mode, ...extra], { cwd: process.cwd(), env: process.env })
  spawned.push(proc)
  return proc
}

async function open(mode: string, extra: string[] = [], timeouts?: { initializeMs?: number; newSessionMs?: number }): Promise<{ s: AcpSession; logs: string[]; proc: ProcLike }> {
  const proc = launch(mode, extra)
  const logs: string[] = []
  const s = await bounded(openAcpSession({ proc, cwd: process.cwd(), clientVersion: '9.9.9', log: (l) => logs.push(l), timeouts }))
  sessions.push(s)
  return { s, logs, proc }
}

/** A process the test scripts by hand: `answer` gets each request the client writes. */
function scripted(answer: (msg: { id: number; method: string; params: Record<string, unknown> }) => unknown): { proc: ProcLike; written: Array<Record<string, unknown>>; killed: () => number } {
  let cb: (line: string) => void = () => {}
  const written: Array<Record<string, unknown>> = []
  let kills = 0
  const proc: ProcLike = {
    pid: 1,
    onLine: (c) => {
      cb = c
    },
    onExit: () => {},
    write: (line) => {
      const msg = JSON.parse(line) as { id?: number; method: string; params: Record<string, unknown> }
      written.push(msg)
      if (msg.id === undefined) return
      let out: Record<string, unknown>
      try {
        out = { jsonrpc: '2.0', id: msg.id, result: answer(msg as { id: number; method: string; params: Record<string, unknown> }) }
      } catch (e) {
        out = { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: (e as Error).message } }
      }
      setImmediate(() => cb(JSON.stringify(out)))
    },
    kill: () => {
      kills++
    }
  }
  return { proc, written, killed: () => kills }
}
const INIT = { protocolVersion: 1, agentInfo: { name: 'n' } }

describe('openAcpSession over a scripted process', () => {
  it('sends the exact initialize and session/new params, ids from 1, and reports the agent', async () => {
    const { proc, written } = scripted((m) => (m.method === 'initialize' ? { ...INIT, agentInfo: { name: 'a', title: 'A', version: '1' } } : { sessionId: 's9' }))
    const s = await openAcpSession({ proc, cwd: 'C:/work', clientVersion: '1.2.3', log: () => {} })
    expect(written[0]).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'Astera', version: '1.2.3' }
      }
    })
    expect(written[1]).toEqual({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: 'C:/work', mcpServers: [] } })
    expect(s.agent).toEqual({ name: 'a', title: 'A', version: '1' })
    s.close()
  })

  it('sends session/set_mode default when the agent starts in another mode that offers it', async () => {
    const { proc, written } = scripted((m) => {
      if (m.method === 'initialize') return INIT
      if (m.method === 'session/new') return { sessionId: 's9', modes: { currentModeId: 'auto', availableModes: [{ id: 'auto' }, { id: 'default' }] } }
      return {}
    })
    const s = await openAcpSession({ proc, cwd: '.', clientVersion: '1', log: () => {} })
    expect(written[2]).toMatchObject({ method: 'session/set_mode', params: { sessionId: 's9', modeId: 'default' } })
    s.close()
  })

  it('does not send set_mode when the agent is already in default or has no default mode', async () => {
    for (const modes of [{ currentModeId: 'default', availableModes: [{ id: 'default' }] }, { currentModeId: 'auto', availableModes: [{ id: 'auto' }] }, undefined]) {
      const { proc, written } = scripted((m) => (m.method === 'initialize' ? INIT : { sessionId: 's9', ...(modes ? { modes } : {}) }))
      const s = await openAcpSession({ proc, cwd: '.', clientVersion: '1', log: () => {} })
      expect(written.map((w) => w.method)).toEqual(['initialize', 'session/new'])
      s.close()
    }
  })

  it('logs a failed set_mode and goes on', async () => {
    const logs: string[] = []
    const { proc } = scripted((m) => {
      if (m.method === 'initialize') return INIT
      if (m.method === 'session/new') return { sessionId: 's9', modes: { currentModeId: 'auto', availableModes: [{ id: 'default' }] } }
      throw new Error('cannot switch')
    })
    const s = await openAcpSession({ proc, cwd: '.', clientVersion: '1', log: (l) => logs.push(l) })
    expect(logs.some((l) => l.includes('set_mode') && l.includes('cannot switch'))).toBe(true)
    s.close()
  })

  it('close kills the process tree once and is idempotent', async () => {
    const { proc, killed } = scripted((m) => (m.method === 'initialize' ? INIT : { sessionId: 's9' }))
    const s = await openAcpSession({ proc, cwd: '.', clientVersion: '1', log: () => {} })
    s.close()
    s.close()
    expect(killed()).toBe(1)
  })

  it('sends the prompt as a text block', async () => {
    const { proc, written } = scripted((m) => (m.method === 'initialize' ? INIT : m.method === 'session/new' ? { sessionId: 's9' } : { stopReason: 'end_turn' }))
    const s = await openAcpSession({ proc, cwd: '.', clientVersion: '1', log: () => {} })
    await expect(s.prompt('hello')).resolves.toEqual({ stopReason: 'end_turn', text: '' })
    expect(written[2]).toMatchObject({ method: 'session/prompt', params: { sessionId: 's9', prompt: [{ type: 'text', text: 'hello' }] } })
    s.close()
  })
})

describe('openAcpSession over the fake agent', () => {
  it('runs a turn: agent info from initialize, the chunks joined, the stop reason', async () => {
    const { s } = await open('approve')
    expect(s.agent).toEqual({ name: 'fake-agent', title: 'Fake Agent', version: '0.0.1' })
    await expect(bounded(s.prompt('review this'))).resolves.toEqual({ stopReason: 'end_turn', text: 'APPROVE' })
  })

  it('prints the --message text as the final message', async () => {
    const { s } = await open('reject', ['--message', 'hello there'])
    await expect(bounded(s.prompt('x'))).resolves.toMatchObject({ text: 'hello there' })
  })

  it('a second prompt on the same session starts a fresh message', async () => {
    const { s } = await open('no-verdict-then-verdict')
    expect((await bounded(s.prompt('1'))).text).toBe('no verdict yet')
    expect((await bounded(s.prompt('2'))).text).toBe('verdict given')
  })

  it('an agent that never gives a verdict answers the same twice', async () => {
    const { s } = await open('no-verdict-twice')
    expect((await bounded(s.prompt('1'))).text).toBe('no verdict yet')
    expect((await bounded(s.prompt('2'))).text).toBe('no verdict yet')
  })

  it('rejects unsupported-version when the agent speaks another protocol version', async () => {
    const proc = launch('bad-version')
    const f = await failureOf(openAcpSession({ proc, cwd: '.', clientVersion: '1', log: () => {} }))
    expect(f.kind).toBe('unsupported-version')
    expect(f.message).toContain('unsupported ACP protocol version 2')
    await until(() => (alive(proc.pid) ? undefined : true))
  })

  it('maps -32000 from session/new to sign-in with the agent message, and kills the agent', async () => {
    const proc = launch('auth-required')
    const f = await failureOf(openAcpSession({ proc, cwd: '.', clientVersion: '1', log: () => {} }))
    expect(f.kind).toBe('sign-in')
    expect(f.message).toBe('Gemini API key is missing or not configured.')
    await until(() => (alive(proc.pid) ? undefined : true))
  })

  it('switches an auto-mode agent to default before the prompt (the agent exits 2 otherwise)', async () => {
    const { s } = await open('auto-mode')
    await expect(bounded(s.prompt('x'))).resolves.toMatchObject({ text: 'mode set' })
  })

  it('skips non-JSON lines, accepts string ids, refuses fs/* with -32601 and never logs a notification payload', async () => {
    const { s, logs } = await open('noisy')
    await expect(bounded(s.prompt('x'))).resolves.toMatchObject({ text: 'noisy ok fs:-32601' })
    expect(logs).toContain('ignored a line that is not JSON')
    expect(logs.join('\n')).not.toContain('someone@example.com')
    expect(logs.join('\n')).not.toContain('auth/status_update')
  })

  it('refuses an edit the agent asks about, logs it, and the turn goes on to its end', async () => {
    const { s, logs } = await open('asks-edit')
    await expect(bounded(s.prompt('x'))).resolves.toMatchObject({ stopReason: 'end_turn', text: 'outcome:reject' })
    expect(logs).toContain('permission edit Edit a.txt: refused')
    expect(logs).toContain('edit pending Edit a.txt')
    expect(logs.some((l) => l.startsWith('edit failed'))).toBe(true)
  })

  it('allows a read the agent asks about with allow_once (the agent exits 4 otherwise)', async () => {
    const { s, logs } = await open('asks-read')
    await expect(bounded(s.prompt('x'))).resolves.toMatchObject({ text: 'read allowed' })
    expect(logs).toContain('permission read Read a.txt: allowed')
    expect(logs).toContain('read completed Read a.txt')
  })

  it('a write that runs without asking rejects the in-flight prompt with violation and closes the session', async () => {
    const { s, proc } = await open('edits-without-asking')
    const f = await failureOf(s.prompt('x'))
    expect(f.kind).toBe('violation')
    expect(f.message).toBe('Edit b.txt')
    await until(() => (alive(proc.pid) ? undefined : true))
    expect((await failureOf(s.prompt('again'))).kind).toBe('violation')
  })

  it('a process that exits mid-turn rejects the prompt with exited and the stderr tail', async () => {
    const { s } = await open('exit-mid-turn')
    const f = await failureOf(s.prompt('x'))
    expect(f.kind).toBe('exited')
    expect(f.stderrTail).toContain('out of memory')
    expect(f.message).toContain('3')
  })

  it('close during a pending prompt rejects quietly with protocol/closed, never exited', async () => {
    const { s, proc } = await open('hang-prompt')
    const turn = s.prompt('x')
    const settled = failureOf(turn)
    await new Promise((r) => setTimeout(r, 100))
    s.close()
    const f = await settled
    expect(f.kind).not.toBe('exited')
    expect(f).toMatchObject({ kind: 'protocol', message: 'closed' })
    await until(() => (alive(proc.pid) ? undefined : true))
    // The exit that close() caused arrives after; it must not turn a later call into 'exited' either.
    await new Promise((r) => setTimeout(r, 300))
    const later = await failureOf(s.prompt('y'))
    expect(later.kind).not.toBe('exited')
  })

  it('initialize that never answers rejects with timeout and kills the agent', async () => {
    const proc = launch('hang-initialize')
    const f = await failureOf(openAcpSession({ proc, cwd: '.', clientVersion: '1', log: () => {}, timeouts: { initializeMs: 200 } }))
    expect(f.kind).toBe('timeout')
    await until(() => (alive(proc.pid) ? undefined : true))
  })

  it('session/new that never answers rejects with timeout', async () => {
    const { proc } = scripted(() => INIT)
    // Never answer session/new: drop that write.
    const write = proc.write
    proc.write = (line) => {
      if (JSON.parse(line).method !== 'session/new') write(line)
    }
    const f = await failureOf(openAcpSession({ proc, cwd: '.', clientVersion: '1', log: () => {}, timeouts: { newSessionMs: 200 } }))
    expect(f.kind).toBe('timeout')
  })
})

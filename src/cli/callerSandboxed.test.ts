import { describe, it, expect, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { askCallerSandboxed } from './callerSandboxed'
import type { connectHost } from '../core/host/connect'
import type { HostMessage } from '../core/host/protocol'

const PROFILE = path.join(os.tmpdir(), 'astera-caller-sandboxed-profile')
const SESSION_ENV = { ASTERA_SESSION: 'ses_1', ASTERA_PROFILE_DIR: PROFILE }

/** A connection that answers every orch-call with `answer`, recording what it was sent. */
function answering(answer: { status: number; body: unknown }) {
  const sent: unknown[] = []
  const connect = vi.fn(async () => {
    let listener: ((m: HostMessage) => void) | null = null
    return {
      hello: { host: 'h', pid: 1, startedAt: 'x', features: [] },
      call: (m: { t: string; call: string }) => {
        sent.push(m)
        queueMicrotask(() => listener?.({ t: 'orch-result', call: m.call, ...answer } as HostMessage))
      },
      onMessage: (cb: (m: HostMessage) => void) => ((listener = cb), () => (listener = null)),
      onClose: () => () => {},
      ref: () => {},
      unref: () => {},
      close: () => {}
    }
  }) as unknown as typeof connectHost
  return { connect, sent }
}

const ask = (env: NodeJS.ProcessEnv, connect: typeof connectHost) =>
  askCallerSandboxed({ env, platform: process.platform, home: os.homedir(), version: '1.4.8', connect })

describe('askCallerSandboxed (remote governance design §7.4)', () => {
  // Ruling R13-4 keeps this for the CLI: no session env is the person's own shell, unrestricted. Only the MCP server
  // reads a missing session as unknown (mcp/remoteLink.ts noSession).
  it('no session in the env asks nothing and answers false', async () => {
    const connect = vi.fn() as unknown as typeof connectHost
    expect(await ask({ ASTERA_PROFILE_DIR: PROFILE }, connect)).toBe(false)
    expect(connect).not.toHaveBeenCalled()
  })

  it('a Host that cannot be reached answers true', async () => {
    const connect = vi.fn(async () => ({ error: 'unreachable' as const })) as unknown as typeof connectHost
    expect(await ask(SESSION_ENV, connect)).toBe(true)
    // A session known only by its workload token asks too
    expect(await ask({ ASTERA_GATEWAY_TOKEN: 'tok', ASTERA_PROFILE_DIR: PROFILE }, connect)).toBe(true)
    expect(connect).toHaveBeenCalledTimes(2)
  })

  it('a 200 with sandboxed false answers false', async () => {
    const h = answering({ status: 200, body: { sandboxed: false } })
    expect(await ask(SESSION_ENV, h.connect)).toBe(false)
    expect(h.sent).toEqual([expect.objectContaining({ t: 'orch-call', cmd: 'caller-sandboxed', args: {}, session: 'ses_1' })])
    expect(await ask(SESSION_ENV, answering({ status: 200, body: { sandboxed: true } }).connect)).toBe(true)
  })

  it('a 403 answers true', async () => {
    expect(await ask(SESSION_ENV, answering({ status: 403, body: { error: 'no' } }).connect)).toBe(true)
    // A workload token the Host does not know (ruling R13-1)
    expect(await ask({ ...SESSION_ENV, ASTERA_GATEWAY_TOKEN: 'stale' }, answering({ status: 401, body: { error: 'workload token not recognised' } }).connect)).toBe(true)
    // So does a Host too old to know the command, and an answer with no boolean in it
    expect(await ask(SESSION_ENV, answering({ status: 400, body: { error: 'unknown command: caller-sandboxed' } }).connect)).toBe(true)
    expect(await ask(SESSION_ENV, answering({ status: 200, body: { sandboxed: 'no' } }).connect)).toBe(true)
  })
})

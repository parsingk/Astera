// A minimal ACP v1 client over a line process (spec 3.3): initialize, session/new, one session/prompt
// at a time, and the policy that keeps a reviewer from changing anything. Hand-written, no SDK; it
// speaks only the methods it needs. See ./permission.ts for the permission policy and ./jsonRpc.ts for
// the framing.
import type { ProcLike } from '../sessions/proc'
import { createJsonRpcPeer, JsonRpcError, JsonRpcTimeout } from './jsonRpc'
import { decidePermission, WRITE_KINDS } from './permission'

export const ACP_PROTOCOL_VERSION = 1

const INITIALIZE_TIMEOUT_MS = 120_000
const NEW_SESSION_TIMEOUT_MS = 60_000
const SIGN_IN_CODE = -32000
const METHOD_NOT_FOUND = -32601

export type AcpFailureKind = 'unsupported-version' | 'sign-in' | 'timeout' | 'exited' | 'violation' | 'protocol'

export class AcpFailure extends Error {
  constructor(public kind: AcpFailureKind, message: string, public stderrTail?: string) {
    super(message)
    this.name = 'AcpFailure'
  }
}

export interface AcpTurn {
  stopReason: string
  text: string
}

export interface AcpSession {
  agent: { name?: string; title?: string; version?: string }
  prompt(text: string): Promise<AcpTurn>
  /** Marks the end intentional, then kills the process tree. Idempotent. After it, nothing rejects with 'exited'. */
  close(): void
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined
}
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

export async function openAcpSession(a: {
  proc: ProcLike
  cwd: string
  clientVersion: string
  /** The transcript sink: one line per call, no payloads of unknown notifications. */
  log(line: string): void
  timeouts?: { initializeMs?: number; newSessionMs?: number }
}): Promise<AcpSession> {
  const { proc, log } = a
  const peer = createJsonRpcPeer({ write: (l) => proc.write(l), onLine: (cb) => void proc.onLine(cb) }, { log })

  /** Set once the session is over, for whatever reason; every pending and later call rejects with it. */
  let terminal: AcpFailure | null = null
  let ended = false
  let sessionId = ''
  /** The message being collected, or null while no prompt is in flight. */
  let turnText: string[] | null = null
  const calls = new Map<string, { kind?: string; title?: string }>()

  function end(failure: AcpFailure | null, kill: boolean): void {
    if (ended) return
    ended = true
    terminal = failure ?? new AcpFailure('protocol', 'closed')
    peer.close(terminal.message)
    if (kill) proc.kill()
  }

  proc.onExit(({ exitCode, stderrTail }) => {
    if (ended) return
    end(new AcpFailure('exited', `the agent process exited with code ${exitCode}${stderrTail ? `: ${stderrTail}` : ''}`, stderrTail), false)
  })

  async function call<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    try {
      return await peer.request<T>(method, params, { timeoutMs })
    } catch (e) {
      if (terminal) throw terminal
      if (e instanceof JsonRpcTimeout) {
        end(new AcpFailure('timeout', e.message), true)
        throw terminal
      }
      throw e
    }
  }

  function onToolCall(u: Record<string, unknown>): void {
    const id = str(u.toolCallId)
    const known = id === undefined ? undefined : calls.get(id)
    const kind = str(u.kind) ?? known?.kind
    const title = str(u.title) ?? known?.title
    if (id !== undefined) calls.set(id, { kind, title })
    const status = str(u.status)
    log(`${kind ?? 'unknown'} ${status ?? 'unknown'} ${title ?? ''}`.trimEnd())
    if (kind !== undefined && WRITE_KINDS.includes(kind) && (status === 'in_progress' || status === 'completed')) {
      end(new AcpFailure('violation', title || kind), true)
    }
  }

  peer.onNotification((method, params) => {
    // Any other notification may carry an account's email (auth/status_update): its payload is not read.
    if (method !== 'session/update') return
    const p = obj(params)
    const u = obj(p?.update)
    if (!p || !u || (sessionId !== '' && p.sessionId !== sessionId)) return
    const kind = str(u.sessionUpdate)
    if (kind === 'agent_message_chunk') {
      const c = obj(u.content)
      if (turnText && c?.type === 'text' && typeof c.text === 'string') turnText.push(c.text)
    } else if (kind === 'tool_call' || kind === 'tool_call_update') onToolCall(u)
    else log(`session/update ${(kind ?? 'unknown').slice(0, 60)}`)
  })

  peer.onRequest((method, params) => {
    if (method !== 'session/request_permission') throw new JsonRpcError(METHOD_NOT_FOUND, `method not found: ${method}`)
    const decision = decidePermission(sessionId, params)
    const tc = obj(obj(params)?.toolCall)
    log(`permission ${str(tc?.kind) ?? 'unknown'} ${str(tc?.title) ?? ''}: ${decision.allowed ? 'allowed' : 'refused'}`)
    return { outcome: decision.outcome }
  })

  try {
    const init = obj(
      await call('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'Astera', version: a.clientVersion }
      }, a.timeouts?.initializeMs ?? INITIALIZE_TIMEOUT_MS)
    )
    if (init?.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new AcpFailure('unsupported-version', `unsupported ACP protocol version ${String(init?.protocolVersion)}`)
    }
    const info = obj(init.agentInfo)
    const agent = { name: str(info?.name), title: str(info?.title), version: str(info?.version) }

    let created: Record<string, unknown> | undefined
    try {
      created = obj(await call('session/new', { cwd: a.cwd, mcpServers: [] }, a.timeouts?.newSessionMs ?? NEW_SESSION_TIMEOUT_MS))
    } catch (e) {
      if (e instanceof JsonRpcError && e.code === SIGN_IN_CODE) throw new AcpFailure('sign-in', e.message)
      throw e
    }
    const id = str(created?.sessionId)
    if (id === undefined) throw new AcpFailure('protocol', 'session/new answered without a sessionId')
    sessionId = id

    const modes = obj(created?.modes)
    const available = Array.isArray(modes?.availableModes) ? modes.availableModes : []
    if (modes?.currentModeId !== 'default' && available.some((m) => obj(m)?.id === 'default')) {
      try {
        await call('session/set_mode', { sessionId, modeId: 'default' })
      } catch (e) {
        if (terminal) throw terminal
        log(`session/set_mode default failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    return {
      agent,
      async prompt(text) {
        turnText = []
        try {
          const r = obj(await call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }))
          return { stopReason: str(r?.stopReason) ?? 'unknown', text: turnText.join('') }
        } catch (e) {
          if (e instanceof AcpFailure) throw e
          throw new AcpFailure('protocol', e instanceof Error ? e.message : String(e))
        } finally {
          turnText = null
        }
      },
      close: () => end(null, true)
    }
  } catch (e) {
    const failure = e instanceof AcpFailure ? e : new AcpFailure('protocol', e instanceof Error ? e.message : String(e))
    end(failure, true)
    throw failure
  }
}

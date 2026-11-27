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
/** A set_mode that does not answer is logged and the review goes on, as any failure of that call does (final fix wave D2). */
export const SET_MODE_TIMEOUT_MS = 30_000
/** One turn's collected message is kept to this many characters, its tail: the verdict is at the end (final fix wave D2). */
export const TURN_TEXT_MAX = 2_000_000
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

/** A permission request as a worker's caller decides it (Phase 5 A1). */
export interface AcpPermissionRequest {
  kind?: string
  title?: string
  options: { optionId: string; kind: string; name?: string }[]
}

export interface AcpSession {
  agent: { name?: string; title?: string; version?: string }
  /** What the agent said it can do in `initialize` (Phase 5 A1): `loadSession` is resuming a session. */
  capabilities: { loadSession: boolean }
  prompt(text: string): Promise<AcpTurn>
  /** Marks the end intentional, then kills the process tree. Idempotent. After it, nothing rejects with 'exited'. */
  close(): void
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined
}
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** `p` whose kill acts once, however often it is called (final fix wave D2): the session's close, the runner's stop and a
 *  probe's cleanup all kill, and each kill of a process tree starts a taskkill on Windows. */
export function killOnce(p: ProcLike): ProcLike {
  let killed = false
  return {
    get pid() {
      return p.pid
    },
    onLine: (cb) => p.onLine(cb),
    onExit: (cb) => p.onExit(cb),
    write: (line, by) => p.write(line, by),
    kill: () => {
      if (killed) return
      killed = true
      p.kill()
    }
  }
}

export async function openAcpSession(a: {
  proc: ProcLike
  cwd: string
  clientVersion: string
  /** The transcript sink: one line per call, no payloads of unknown notifications. */
  log(line: string): void
  timeouts?: { initializeMs?: number; newSessionMs?: number; setModeMs?: number }
  /** A worker (Phase 5 A1): the caller answers each permission request with the option id it picks (null cancels), and a
   *  write is the agent doing its work, not a violation. Absent: the reviewer's policy (reads only, a write ends it). */
  worker?: { decide(req: AcpPermissionRequest): Promise<string | null> }
}): Promise<AcpSession> {
  const { proc, log } = a
  const peer = createJsonRpcPeer({ write: (l) => proc.write(l), onLine: (cb) => void proc.onLine(cb) }, { log })

  /** Set once the session is over, for whatever reason; every pending and later call rejects with it. */
  let terminal: AcpFailure | null = null
  let ended = false
  let sessionId = ''
  /** The message being collected, or null while no prompt is in flight; `size` is the characters held in `parts`. */
  let turnText: { parts: string[]; size: number } | null = null
  /** Adds a chunk; past twice the cap the parts are joined and cut to the cap's tail, so an agent that never stops talking
   *  costs at most that much (final fix wave D2). */
  const collect = (t: { parts: string[]; size: number }, chunk: string): void => {
    t.parts.push(chunk)
    t.size += chunk.length
    if (t.size > 2 * TURN_TEXT_MAX) {
      const kept = t.parts.join('').slice(-TURN_TEXT_MAX)
      t.parts = [kept]
      t.size = kept.length
    }
  }
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
    if (!a.worker && kind !== undefined && WRITE_KINDS.includes(kind) && (status === 'in_progress' || status === 'completed')) {
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
      if (turnText && c?.type === 'text' && typeof c.text === 'string') collect(turnText, c.text)
    } else if (kind === 'tool_call' || kind === 'tool_call_update') onToolCall(u)
    else log(`session/update ${(kind ?? 'unknown').slice(0, 60)}`)
  })

  peer.onRequest(async (method, params) => {
    if (method !== 'session/request_permission') throw new JsonRpcError(METHOD_NOT_FOUND, `method not found: ${method}`)
    if (a.worker) {
      const p = obj(params)
      const tc = obj(p?.toolCall)
      const options = (Array.isArray(p?.options) ? p.options : [])
        .map((o) => obj(o))
        .filter((o): o is Record<string, unknown> => o !== undefined && typeof o.optionId === 'string' && typeof o.kind === 'string')
        .map((o) => ({ optionId: o.optionId as string, kind: o.kind as string, ...(typeof o.name === 'string' ? { name: o.name } : {}) }))
      const req: AcpPermissionRequest = { ...(str(tc?.kind) ? { kind: str(tc?.kind) } : {}), ...(str(tc?.title) ? { title: str(tc?.title) } : {}), options }
      // Only an option the agent offered is ever sent back
      const picked = p?.sessionId === sessionId ? await a.worker.decide(req) : null
      const chosen = picked !== null && options.some((o) => o.optionId === picked) ? picked : null
      log(`permission ${req.kind ?? 'unknown'} ${req.title ?? ''}: ${chosen ?? 'cancelled'}`)
      return { outcome: chosen !== null ? { outcome: 'selected', optionId: chosen } : { outcome: 'cancelled' } }
    }
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
    const capabilities = { loadSession: obj(init.agentCapabilities)?.loadSession === true }

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
        // Not through `call`: a timeout there ends the session, and this call's failures, a timeout included, only log
        await peer.request('session/set_mode', { sessionId, modeId: 'default' }, { timeoutMs: a.timeouts?.setModeMs ?? SET_MODE_TIMEOUT_MS })
      } catch (e) {
        if (terminal) throw terminal
        log(`session/set_mode default failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    return {
      agent,
      capabilities,
      async prompt(text) {
        const collected = { parts: [] as string[], size: 0 }
        turnText = collected
        try {
          const r = obj(await call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }))
          return { stopReason: str(r?.stopReason) ?? 'unknown', text: collected.parts.join('').slice(-TURN_TEXT_MAX) }
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

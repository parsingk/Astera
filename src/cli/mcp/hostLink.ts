// One connection to the Host for the life of `astera mcp serve` (MCP design §4). The CLI's own
// `callHost` fixes its call id to 'cli_1' and lives for one command; this link numbers its calls,
// reconnects when the Host goes, and starts one when none answers (M4). It never reads stdin or writes
// stdout.
import type { ConnectFailure, HostConnection } from '../../core/host/connect'
import { HOST_FEATURE_MCP, HOST_FEATURE_ORCH } from '../../core/host/protocol'
import type { HostAnswer } from '../run'

export type LinkFailure = { code: 'HOST_NOT_RUNNING' | 'VERSION_MISMATCH' | 'PERMISSION_DENIED' | 'TIMEOUT'; message: string }

export interface HostLink {
  call(cmd: string, args: Record<string, unknown>, request?: string): Promise<HostAnswer | LinkFailure>
  close(): void
}

const isFailure = (c: HostConnection | ConnectFailure): c is ConnectFailure => 'error' in c

export function openHostLink(a: {
  connect(): Promise<HostConnection | ConnectFailure>
  /** Starts a Host when none answers (MCP design M4). Resolves true when one now answers. */
  startHost(): Promise<boolean>
  log(m: string): void
  /** Per-call deadline. No MCP tool long-polls. */
  timeoutMs?: number
}): HostLink {
  // 50 s: Cursor cuts a tool call at 60 s and Codex documents 60 s as its default, so answering
  // TIMEOUT first lets the agent see why the call ended instead of a bare client-side cut.
  const timeoutMs = a.timeoutMs ?? 50_000
  // A connection and the calls sent on it: its close flushes only these.
  type Live = { c: HostConnection; pending: Map<string, (r: HostAnswer | LinkFailure) => void> }
  let conn: Promise<Live | LinkFailure> | null = null
  let current: Live | null = null
  let closed = false
  let next = 1

  const failureOf = (f: ConnectFailure): LinkFailure =>
    f.error === 'impostor'
      ? { code: 'PERMISSION_DENIED', message: "something answered at the Host's address but could not prove it is this account's Host" }
      : f.error === 'protocol'
        ? { code: 'VERSION_MISMATCH', message: 'the Host speaks another protocol; update Astera so the app and the CLI match' }
        : { code: 'HOST_NOT_RUNNING', message: 'Astera Host is not running and could not be started. Start it with `astera host start`.' }

  const open = async (): Promise<Live | LinkFailure> => {
    let c = await a.connect()
    if (isFailure(c) && c.error === 'unreachable' && (await a.startHost())) c = await a.connect()
    if (isFailure(c)) return failureOf(c)
    if (!c.hello.features.includes(HOST_FEATURE_ORCH) || !c.hello.features.includes(HOST_FEATURE_MCP)) {
      c.close()
      return { code: 'VERSION_MISMATCH', message: `the Host (${c.hello.host}) is too old for MCP clients; update Astera` }
    }
    const live: Live = { c, pending: new Map() }
    const { pending } = live
    c.onMessage((m) => {
      if (m.t !== 'orch-result') return
      const done = pending.get(m.call)
      if (!done) return
      pending.delete(m.call)
      done({
        status: m.status,
        body: m.body,
        ...(m.replayed === true ? { replayed: true as const } : {}),
        ...(m.observed === true ? { observed: true as const } : {})
      })
    })
    c.onClose(() => {
      if (current === live) {
        current = null
        conn = null
      }
      a.log('the Host connection closed')
      for (const [id, done] of pending) {
        pending.delete(id)
        done({ code: 'HOST_NOT_RUNNING', message: 'the Host went away during the call; retry with the same requestId' })
      }
    })
    current = live
    return live
  }

  return {
    async call(cmd, args, request) {
      if (closed) return { code: 'HOST_NOT_RUNNING', message: 'the MCP server is shutting down' }
      if (conn === null) conn = open()
      const mine = conn
      const l = await mine
      if ('code' in l) {
        if (conn === mine) conn = null
        return l
      }
      // The connection can close between its open resolving and this call resuming; its close has
      // flushed `pending` already, so a call registered on it now would wait out the whole deadline.
      if (current !== l) return { code: 'HOST_NOT_RUNNING', message: 'the Host went away during the call; retry with the same requestId' }
      const call = `mcp_${next++}`
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          l.pending.delete(call)
          resolve({
            code: 'TIMEOUT',
            message: `the Host did not answer ${cmd} within ${Math.round(timeoutMs / 1000)} s; ${
              cmd === 'jobs-run'
                ? 'the Run may still be starting, check with get_job'
                : 'the command may still finish, re-read with a get_ tool'
            }`
          })
        }, timeoutMs)
        l.pending.set(call, (r) => {
          clearTimeout(timer)
          resolve(r)
        })
        l.c.call({ t: 'orch-call', call, cmd, args, session: '', ...(request !== undefined ? { request } : {}) })
      })
    },
    close() {
      closed = true
      void conn?.then((l) => ('code' in l ? undefined : l.c.close()))
      conn = null
    }
  }
}

// One connection to the Host for the life of `astera mcp serve` (MCP design §4). The CLI's own
// `callHost` fixes its call id to 'cli_1' and lives for one command; this link numbers its calls,
// reconnects when the Host goes, and starts one when none answers (M4). It never reads stdin or writes
// stdout.
import type { ConnectFailure, HostConnection } from '../../core/host/connect'
import { HOST_FEATURE_MCP, HOST_FEATURE_ORCH } from '../../core/host/protocol'
import type { HostAnswer } from '../run'

export type LinkFailure = { code: 'HOST_NOT_RUNNING' | 'VERSION_MISMATCH' | 'PERMISSION_DENIED'; message: string }

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
}): HostLink {
  let conn: Promise<HostConnection | LinkFailure> | null = null
  let next = 1
  const pending = new Map<string, (r: HostAnswer | LinkFailure) => void>()

  const failureOf = (f: ConnectFailure): LinkFailure =>
    f.error === 'impostor'
      ? { code: 'PERMISSION_DENIED', message: "something answered at the Host's address but could not prove it is this account's Host" }
      : f.error === 'protocol'
        ? { code: 'VERSION_MISMATCH', message: 'the Host speaks another protocol; update Astera so the app and the CLI match' }
        : { code: 'HOST_NOT_RUNNING', message: 'Astera Host is not running and could not be started. Start it with `astera host start`.' }

  const open = async (): Promise<HostConnection | LinkFailure> => {
    let c = await a.connect()
    if (isFailure(c) && c.error === 'unreachable' && (await a.startHost())) c = await a.connect()
    if (isFailure(c)) return failureOf(c)
    if (!c.hello.features.includes(HOST_FEATURE_ORCH) || !c.hello.features.includes(HOST_FEATURE_MCP)) {
      c.close()
      return { code: 'VERSION_MISMATCH', message: `the Host (${c.hello.host}) is too old for MCP clients; update Astera` }
    }
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
      conn = null
      a.log('the Host connection closed')
      for (const [id, done] of pending) {
        pending.delete(id)
        done({ code: 'HOST_NOT_RUNNING', message: 'the Host went away during the call; retry with the same requestId' })
      }
    })
    return c
  }

  return {
    async call(cmd, args, request) {
      if (conn === null) conn = open()
      const c = await conn
      if ('code' in c) {
        conn = null
        return c
      }
      const call = `mcp_${next++}`
      return new Promise((resolve) => {
        pending.set(call, resolve)
        c.call({ t: 'orch-call', call, cmd, args, session: '', ...(request !== undefined ? { request } : {}) })
      })
    },
    close() {
      void conn?.then((c) => ('code' in c ? undefined : c.close()))
      conn = null
    }
  }
}

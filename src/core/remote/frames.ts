// The remote protocol's frames and their schemas (remote runtime design §3.1 to §3.3). Valid JSON is not a valid
// command: every decoded frame is checked here, field by field, before anything acts on it. A parser builds a new
// object from the fields it knows, so a field a sender added (a `role`, `permission`, `session` or `principal`)
// never travels further (D2.1).

export const FRAME_CAP = 1 << 20
export const STRING_CAP = 64 * 1024
export const GATEWAY_PROTOCOL = 1

export type Surface = 'desktop' | 'cli' | 'mcp'
export interface ClientInfo {
  name?: string
  version?: string
  surface?: Surface
}

/** Controller to Gateway. */
export type ControllerFrame =
  | { t: 'auth'; token: string; client: ClientInfo }
  | { t: 'redeem'; code: string; name: string; client: ClientInfo }
  | { t: 'call'; id: string; cmd: string; args: Record<string, unknown>; request?: string; retry?: true }
  | { t: 'ping' }
  | { t: 'pong' }

export interface HelloFrame {
  t: 'hello'
  runtimeId: string
  displayName: string
  asteraVersion: string
  hostProtocol: number
  gatewayProtocol: number
  bootId: string
  platform: string
  pathStyle: 'posix' | 'windows'
  permission: 'read-only' | 'full-control'
  capabilities: string[]
}

/** Gateway to controller. */
export type ServerFrame =
  | HelloFrame
  | { t: 'result'; id: string; status: number; body: unknown; replayed?: true; observed?: true }
  | { t: 'error'; code: string; message: string; id?: string }
  | { t: 'paired'; clientId: string; token: string }
  | { t: 'chunk'; ref: string; i: number; n: number; data: string }
  | { t: 'closing'; code: string }
  | { t: 'ping' }
  | { t: 'pong' }

/** Gateway to Host, over the link. */
export type GatewayLinkFrame =
  | { t: 'gateway-ready'; port: number; address: string; fingerprint: string }
  | { t: 'gateway-failed'; code: string; message: string }
  | { t: 'auth'; conn: string; tokenHash: string }
  | { t: 'redeem'; conn: string; code: string; name: string }
  | { t: 'call'; conn: string; id: string; cmd: string; args: Record<string, unknown>; request?: string; retry?: true }
  | { t: 'conn-closed'; conn: string }

/** Host to Gateway, over the link. */
export type HostLinkFrame =
  | { t: 'authed'; conn: string; ok: boolean; hello?: HelloFrame }
  | { t: 'redeemed'; conn: string; ok: boolean; clientId?: string; token?: string; reason?: string }
  | { t: 'result'; conn: string; id: string; status: number; body: unknown; replayed?: true; observed?: true }
  | { t: 'close-conn'; conn: string; code: string }
  /** A piece of a result too large for one link line (§3.1): the Gateway puts the pieces together. */
  | { t: 'chunk'; conn: string; ref: string; i: number; n: number; data: string }

type Fail = { error: string }
const fail = (error: string): Fail => ({ error })
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, max = STRING_CAP): v is string => typeof v === 'string' && v.length <= max
const CMD = /^[a-z][a-z0-9-]{0,63}$/
const ID_MAX = 128

const client = (v: unknown): ClientInfo | null => {
  if (v === undefined) return {}
  if (!isObj(v)) return null
  const out: ClientInfo = {}
  if (v.name !== undefined) {
    if (!str(v.name, 128)) return null
    out.name = v.name
  }
  if (v.version !== undefined) {
    if (!str(v.version, 64)) return null
    out.version = v.version
  }
  if (v.surface !== undefined) {
    if (v.surface !== 'desktop' && v.surface !== 'cli' && v.surface !== 'mcp') return null
    out.surface = v.surface
  }
  return out
}

/** A call's own fields, the same on both hops. */
const call = (v: Record<string, unknown>): Omit<Extract<ControllerFrame, { t: 'call' }>, 't'> | Fail => {
  if (!str(v.id, ID_MAX) || v.id === '') return fail('call needs an id')
  if (!str(v.cmd) || !CMD.test(v.cmd)) return fail('call needs a command name')
  if (!isObj(v.args)) return fail('call args must be an object')
  if (v.request !== undefined && (!str(v.request, ID_MAX) || v.request === '')) return fail('request must be a short string')
  if (v.retry !== undefined && v.retry !== true) return fail('retry must be true when given')
  return {
    id: v.id,
    cmd: v.cmd,
    args: v.args,
    ...(v.request !== undefined ? { request: v.request as string } : {}),
    ...(v.retry === true ? { retry: true as const } : {})
  }
}

export function parseControllerFrame(v: unknown): ControllerFrame | Fail {
  if (!isObj(v)) return fail('a frame is an object')
  switch (v.t) {
    case 'auth': {
      const c = client(v.client)
      if (!str(v.token, 256) || v.token === '' || !c) return fail('auth needs a token')
      return { t: 'auth', token: v.token, client: c }
    }
    case 'redeem': {
      const c = client(v.client)
      if (!str(v.code, 64) || !str(v.name, 128) || !c) return fail('redeem needs a code and a name')
      return { t: 'redeem', code: v.code, name: v.name, client: c }
    }
    case 'call': {
      const c = call(v)
      return 'error' in c ? c : { t: 'call', ...c }
    }
    case 'ping':
    case 'pong':
      return { t: v.t }
    default:
      return fail(`unknown frame type ${JSON.stringify(String(v.t)).slice(0, 40)}`)
  }
}

export function parseLinkFrame(v: unknown, from: 'gateway'): GatewayLinkFrame | Fail
export function parseLinkFrame(v: unknown, from: 'host'): HostLinkFrame | Fail
export function parseLinkFrame(v: unknown, from: 'gateway' | 'host'): GatewayLinkFrame | HostLinkFrame | Fail {
  if (!isObj(v)) return fail('a frame is an object')
  const conn = str(v.conn, ID_MAX) && v.conn !== '' ? v.conn : null
  if (from === 'gateway') {
    switch (v.t) {
      case 'gateway-ready':
        if (typeof v.port !== 'number' || !str(v.address, 256) || !str(v.fingerprint, 128)) return fail('bad gateway-ready')
        return { t: 'gateway-ready', port: v.port, address: v.address, fingerprint: v.fingerprint }
      case 'gateway-failed':
        if (!str(v.code, 64) || !str(v.message, 1024)) return fail('bad gateway-failed')
        return { t: 'gateway-failed', code: v.code, message: v.message }
      case 'auth':
        if (!conn || !str(v.tokenHash, 128)) return fail('bad auth')
        return { t: 'auth', conn, tokenHash: v.tokenHash }
      case 'redeem':
        if (!conn || !str(v.code, 64) || !str(v.name, 128)) return fail('bad redeem')
        return { t: 'redeem', conn, code: v.code, name: v.name }
      case 'call': {
        if (!conn) return fail('call needs a conn')
        const c = call(v)
        return 'error' in c ? c : { t: 'call', conn, ...c }
      }
      case 'conn-closed':
        if (!conn) return fail('bad conn-closed')
        return { t: 'conn-closed', conn }
      default:
        return fail(`unknown link frame ${JSON.stringify(String(v.t)).slice(0, 40)}`)
    }
  }
  switch (v.t) {
    case 'authed':
      if (!conn || typeof v.ok !== 'boolean') return fail('bad authed')
      return { t: 'authed', conn, ok: v.ok, ...(isObj(v.hello) ? { hello: v.hello as unknown as HelloFrame } : {}) }
    case 'redeemed':
      if (!conn || typeof v.ok !== 'boolean') return fail('bad redeemed')
      return {
        t: 'redeemed',
        conn,
        ok: v.ok,
        ...(str(v.clientId, ID_MAX) ? { clientId: v.clientId } : {}),
        ...(str(v.token, 256) ? { token: v.token } : {}),
        ...(str(v.reason, 64) ? { reason: v.reason } : {})
      }
    case 'result':
      if (!conn || !str(v.id, ID_MAX) || typeof v.status !== 'number') return fail('bad result')
      return {
        t: 'result',
        conn,
        id: v.id,
        status: v.status,
        body: v.body,
        ...(v.replayed === true ? { replayed: true as const } : {}),
        ...(v.observed === true ? { observed: true as const } : {})
      }
    case 'close-conn':
      if (!conn || !str(v.code, 64)) return fail('bad close-conn')
      return { t: 'close-conn', conn, code: v.code }
    case 'chunk':
      if (!conn || !str(v.ref, ID_MAX) || !Number.isInteger(v.i) || !Number.isInteger(v.n) || !str(v.data, FRAME_CAP)) return fail('bad chunk')
      return { t: 'chunk', conn, ref: v.ref, i: v.i as number, n: v.n as number, data: v.data }
    default:
      return fail(`unknown link frame ${JSON.stringify(String(v.t)).slice(0, 40)}`)
  }
}

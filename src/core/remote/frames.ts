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
  /** A pty's output from `fromSeq` on (§3.7); without it, or from another boot, a checkpoint first. */
  | { t: 'subscribe'; sub: string; pty: string; fromSeq?: number; bootId?: string }
  | { t: 'unsubscribe'; sub: string }

/** A pty event as it travels (host/ptyRing.ts PtyEvent). */
export type RemotePtyEvent =
  | { seq: number; kind: 'data'; data: string }
  | { seq: number; kind: 'resize'; cols: number; rows: number }
  | { seq: number; kind: 'exit'; code: number | null }

/** A pty checkpoint as it travels (host/liveTerminal.ts PtyCheckpoint): write `state`, then `pending`, then the events
 *  after `watermark`. */
export interface RemoteCheckpoint {
  watermark: number
  cols: number
  rows: number
  state: string
  pending: string
  exitCode?: number | null
}

/** What a subscription is sent (§3.7), on both hops: the Host's frames carry `conn`, the Gateway's do not. An
 *  `output-gap` ends the stream (an overflow): the controller subscribes again from its last seq. A gap at subscribe
 *  time travels in the checkpoint instead. */
export type SubscriptionFrame =
  | { t: 'subscribed'; sub: string; pty: string; bootId: string }
  | { t: 'pty-out'; sub: string; events: RemotePtyEvent[] }
  | { t: 'checkpoint'; sub: string; checkpoint: RemoteCheckpoint; gap: { firstSeq: number; lastSeq: number } }
  | { t: 'output-gap'; sub: string; firstSeq: number; lastSeq: number; code: 'OUTPUT_GAP' }
  | { t: 'sub-error'; sub: string; code: string; message: string }

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
  | SubscriptionFrame

/** Gateway to Host, over the link. */
export type GatewayLinkFrame =
  | { t: 'gateway-ready'; port: number; address: string; fingerprint: string }
  | { t: 'gateway-failed'; code: string; message: string }
  | { t: 'auth'; conn: string; tokenHash: string }
  | { t: 'redeem'; conn: string; code: string; name: string }
  | { t: 'call'; conn: string; id: string; cmd: string; args: Record<string, unknown>; request?: string; retry?: true }
  | { t: 'conn-closed'; conn: string }
  | { t: 'subscribe'; conn: string; sub: string; pty: string; fromSeq?: number; bootId?: string }
  | { t: 'unsubscribe'; conn: string; sub: string }

/** Host to Gateway, over the link. */
export type HostLinkFrame =
  | { t: 'authed'; conn: string; ok: boolean; hello?: HelloFrame }
  | { t: 'redeemed'; conn: string; ok: boolean; clientId?: string; token?: string; reason?: string }
  | { t: 'result'; conn: string; id: string; status: number; body: unknown; replayed?: true; observed?: true }
  | { t: 'close-conn'; conn: string; code: string }
  /** A piece of a result too large for one link line (§3.1): the Gateway puts the pieces together. */
  | { t: 'chunk'; conn: string; ref: string; i: number; n: number; data: string }
  | (SubscriptionFrame & { conn: string })

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

const seqOk = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1
const sizeOk = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10_000

/** A subscription's own fields, the same on both hops. */
const subscribe = (v: Record<string, unknown>): { sub: string; pty: string; fromSeq?: number; bootId?: string } | Fail => {
  if (!str(v.sub, ID_MAX) || v.sub === '') return fail('subscribe needs a sub id')
  if (!str(v.pty, ID_MAX) || v.pty === '') return fail('subscribe needs a pty')
  if (v.fromSeq !== undefined && !seqOk(v.fromSeq)) return fail('fromSeq is a whole number from 1')
  if (v.bootId !== undefined && (!str(v.bootId, ID_MAX) || v.bootId === '')) return fail('bootId must be a short string')
  return { sub: v.sub, pty: v.pty, ...(v.fromSeq !== undefined ? { fromSeq: v.fromSeq as number } : {}), ...(v.bootId !== undefined ? { bootId: v.bootId as string } : {}) }
}

const ptyEvent = (v: unknown): RemotePtyEvent | null => {
  if (!isObj(v) || !seqOk(v.seq)) return null
  if (v.kind === 'data' && str(v.data)) return { seq: v.seq, kind: 'data', data: v.data }
  if (v.kind === 'resize' && sizeOk(v.cols) && sizeOk(v.rows)) return { seq: v.seq, kind: 'resize', cols: v.cols, rows: v.rows }
  if (v.kind === 'exit' && (v.code === null || Number.isInteger(v.code))) return { seq: v.seq, kind: 'exit', code: v.code as number | null }
  return null
}

const checkpoint = (v: unknown): RemoteCheckpoint | null => {
  if (!isObj(v) || !Number.isInteger(v.watermark) || (v.watermark as number) < 0 || !sizeOk(v.cols) || !sizeOk(v.rows)) return null
  // The state is sent in chunks when it is large (§3.1), so it is bounded by the reassembly, not by a string field.
  if (typeof v.state !== 'string' || !str(v.pending)) return null
  return {
    watermark: v.watermark as number,
    cols: v.cols,
    rows: v.rows,
    state: v.state,
    pending: v.pending,
    ...(v.exitCode !== undefined && (v.exitCode === null || Number.isInteger(v.exitCode)) ? { exitCode: v.exitCode as number | null } : {})
  }
}

/** The Host's subscription frames, read by the Gateway (the controller library reads the same shapes). */
export function parseSubscriptionFrame(v: Record<string, unknown>): SubscriptionFrame | Fail {
  if (!str(v.sub, ID_MAX) || v.sub === '') return fail(`${String(v.t)} needs a sub id`)
  const sub = v.sub
  switch (v.t) {
    case 'subscribed':
      if (!str(v.pty, ID_MAX) || !str(v.bootId, ID_MAX)) return fail('bad subscribed')
      return { t: 'subscribed', sub, pty: v.pty, bootId: v.bootId }
    case 'pty-out': {
      if (!Array.isArray(v.events) || v.events.length > 4096) return fail('bad pty-out')
      const events: RemotePtyEvent[] = []
      for (const e of v.events) {
        const ok = ptyEvent(e)
        if (!ok) return fail('bad pty event')
        events.push(ok)
      }
      return { t: 'pty-out', sub, events }
    }
    case 'checkpoint': {
      const cp = checkpoint(v.checkpoint)
      const gap = v.gap
      if (!cp || !isObj(gap) || !Number.isInteger(gap.firstSeq) || !Number.isInteger(gap.lastSeq)) return fail('bad checkpoint')
      return { t: 'checkpoint', sub, checkpoint: cp, gap: { firstSeq: gap.firstSeq as number, lastSeq: gap.lastSeq as number } }
    }
    case 'output-gap':
      if (!Number.isInteger(v.firstSeq) || !Number.isInteger(v.lastSeq)) return fail('bad output-gap')
      return { t: 'output-gap', sub, firstSeq: v.firstSeq as number, lastSeq: v.lastSeq as number, code: 'OUTPUT_GAP' }
    case 'sub-error':
      if (!str(v.code, 64) || !str(v.message, 1024)) return fail('bad sub-error')
      return { t: 'sub-error', sub, code: v.code, message: v.message }
    default:
      return fail('not a subscription frame')
  }
}

const SUBSCRIPTION_FRAMES = new Set(['subscribed', 'pty-out', 'checkpoint', 'output-gap', 'sub-error'])

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
    case 'subscribe': {
      const sub = subscribe(v)
      return 'error' in sub ? sub : { t: 'subscribe', ...sub }
    }
    case 'unsubscribe':
      if (!str(v.sub, ID_MAX) || v.sub === '') return fail('unsubscribe needs a sub id')
      return { t: 'unsubscribe', sub: v.sub }
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
      case 'subscribe': {
        if (!conn) return fail('subscribe needs a conn')
        const sub = subscribe(v)
        return 'error' in sub ? sub : { t: 'subscribe', conn, ...sub }
      }
      case 'unsubscribe':
        if (!conn || !str(v.sub, ID_MAX) || v.sub === '') return fail('bad unsubscribe')
        return { t: 'unsubscribe', conn, sub: v.sub }
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
      if (typeof v.t === 'string' && SUBSCRIPTION_FRAMES.has(v.t)) {
        if (!conn) return fail(`${v.t} needs a conn`)
        const f = parseSubscriptionFrame(v)
        return 'error' in f ? f : { ...f, conn }
      }
      return fail(`unknown link frame ${JSON.stringify(String(v.t)).slice(0, 40)}`)
  }
}

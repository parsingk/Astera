// The Host's end of the link to its Remote Gateway (remote runtime design §2.4, §3.3). The Gateway is the Host's own
// child, but it faces the network, so nothing it says is believed beyond what it can know: a connection id, a token
// hash, a pairing code, a call. Who a connection is comes from this Host's bindings and client records alone (X1-08),
// and every call runs through `createHostOrch(...).call` as a `controller`, behind the controller gate.
//
// It is not a socket client: idle exit never counts it, it holds nothing, receives no `orch-act`, no yields and no
// broadcast, and it has no route to `state-put`, `retire`, `pty-*`, `proc-*` or any app-only call (§2.4).
//
// **Pty subscriptions (§3.7, Phase 8).** A bound connection may subscribe to a pty's output, read only: it gets the
// events from its seq, or a checkpoint (carrying the gap) and the events after its watermark, then live output, each
// on the link's stream lane under a per-stream and a total budget. Past either, the stream ends with `output-gap` and
// the controller subscribes again. It can never pause or resume a pty: there is no such frame (N2).
import type { Readable, Writable } from 'node:stream'
import { createLineReader } from './framing'
import type { ControllerRegistry } from './controllers'
import type { OrchCall } from '../core/host/orchProtocol'
import { createLaneWriter } from '../core/remote/lanes'
import { FRAME_CAP, parseLinkFrame, type GatewayLinkFrame, type HelloFrame, type HostLinkFrame } from '../core/remote/frames'
import { CHUNK_THRESHOLD, REASSEMBLED_CAP, chunksOf } from '../core/remote/chunks'
import type { PtyRegistry } from './registry'
import type { PtyEvent } from './ptyRing'

/** The control lane's hard cap (§3.1, DC-2): past it the Gateway is not reading, and it is killed. */
export const LINK_HARD_CAP = 8 << 20
/** Subscriptions one connection may hold (§3.1). */
export const SUBS_PER_CONN = 64
/** Output one pty stream may have waiting on the link (§3.1, N2). */
export const LINK_STREAM_MAX = 4 << 20
/** Output every stream together may have waiting on the link (§3.1). */
export const LINK_OUTPUT_MAX = 32 << 20

export interface GatewayLinkHandle {
  /** Sends `close-conn` for the connections of this link's generation (revocation, §3.3). Others are ignored. */
  closeConns(conns: Array<{ linkGen: number; conn: string }>): void
  /** This link is gone: every binding it held goes (§3.3, link generations). */
  detach(): void
}

export function attachGatewayLink(o: {
  linkGen: number
  input: Readable
  output: Writable
  controllers: ControllerRegistry
  orch: Pick<OrchCall, 'call'>
  hello(): Omit<HelloFrame, 't' | 'permission'>
  log(message: string): void
  onReady(f: Extract<GatewayLinkFrame, { t: 'gateway-ready' }>): void
  onFailed(f: Extract<GatewayLinkFrame, { t: 'gateway-failed' }>): void
  onHardCap(): void
  hardCap?: number
  /** The pty registry, for subscriptions (§3.7). Absent: a subscription is refused as a missing capability. */
  ptys?: Pick<PtyRegistry, 'replayFrom' | 'onEvent' | 'bootId'>
  /** The stream budgets, for tests; LINK_STREAM_MAX and LINK_OUTPUT_MAX otherwise. */
  streamPerKey?: number
  streamTotal?: number
}): GatewayLinkHandle {
  let detached = false
  let capped = false
  const hardCap = (): void => {
    if (capped) return
    capped = true
    o.onHardCap()
  }
  /** One subscription: which connection and pty, whether its replay is done, events that came during the replay, and
   *  the last seq handed to the stream (nothing at or below it is sent again). */
  type Sub = { key: string; conn: string; sub: string; pty: string; live: boolean; held: PtyEvent[]; last: number }
  const subs = new Map<string, Sub>()
  const keyOf = (conn: string, sub: string): string => `${conn}\u0000${sub}`
  const out = createLaneWriter(o.output, {
    hardCap: o.hardCap ?? LINK_HARD_CAP,
    onHardCap: hardCap,
    streamPerKey: o.streamPerKey ?? LINK_STREAM_MAX,
    streamTotal: o.streamTotal ?? LINK_OUTPUT_MAX,
    // The stream is ended, not trimmed: a controller that applied later events after a hole would show a wrong screen.
    onStreamOverflow: (key, lost) => {
      const s = subs.get(key)
      if (!s) return
      subs.delete(key)
      o.log(`remote: a pty stream fell behind its budget and was ended (pty ${s.pty})`)
      send({ t: 'output-gap', conn: s.conn, sub: s.sub, firstSeq: lost.firstSeq, lastSeq: lost.lastSeq, code: 'OUTPUT_GAP' })
    }
  })
  const push = (s: Sub, e: PtyEvent): void => {
    if (e.seq <= s.last) return
    s.last = e.seq
    out.stream(s.key, `${JSON.stringify({ t: 'pty-out', conn: s.conn, sub: s.sub, events: [e] })}\n`, e.seq)
  }
  const stopEvents = o.ptys?.onEvent((id, e) => {
    for (const s of subs.values()) {
      if (s.pty !== id) continue
      if (s.live) push(s, e)
      else s.held.push(e)
    }
  })
  const dropSub = (key: string): void => {
    subs.delete(key)
    out.dropStream(key)
  }
  let ref = 0
  /** One frame, or a large one in pieces (§3.1): a link line over the Gateway's cap would stop its reader for good. */
  const send = (f: HostLinkFrame): void => {
    if (detached) return
    const line = JSON.stringify(f)
    const bytes = Buffer.byteLength(line)
    if (bytes <= CHUNK_THRESHOLD) return out.control(`${line}\n`)
    if (f.t === 'result' && bytes > REASSEMBLED_CAP)
      return send({
        t: 'result',
        conn: f.conn,
        id: f.id,
        status: 500,
        body: { error: `the reply is ${bytes} bytes, over the 64 MiB a remote reply may be`, code: 'REMOTE_REPLY_TOO_LARGE' }
      })
    for (const c of chunksOf(`h${++ref}`, line)) out.control(`${JSON.stringify({ ...c, conn: f.conn })}\n`)
  }

  /** Connections with a pairing being saved, and those of them that closed meanwhile. */
  const redeeming = new Set<string>()
  const closedConns = new Set<string>()
  const onFrame = async (f: GatewayLinkFrame): Promise<void> => {
    switch (f.t) {
      case 'gateway-ready':
        return o.onReady(f)
      case 'gateway-failed':
        return o.onFailed(f)
      case 'auth': {
        const r = o.controllers.authenticate(f.tokenHash)
        if (!r) return send({ t: 'authed', conn: f.conn, ok: false })
        o.controllers.bind(o.linkGen, f.conn, r.clientId)
        return send({ t: 'authed', conn: f.conn, ok: true, hello: { t: 'hello', ...o.hello(), permission: r.permission } })
      }
      case 'redeem': {
        redeeming.add(f.conn)
        // Neither the code nor the token is logged, here or anywhere (§4.7).
        const r = await o.controllers.redeem(f.code, f.name).catch((e: unknown) => {
          o.log(`remote: a pairing could not be saved: ${e instanceof Error ? e.message : String(e)}`)
          return { ok: false as const, reason: 'unsaved' as const }
        })
        redeeming.delete(f.conn)
        if (!r.ok) closedConns.delete(f.conn)
        if (r.ok) {
          // The connection closed while this was saved (Phase 3 minor): nobody can receive the token, so the record it
          // would unlock is taken back rather than left as a pairing nobody holds.
          if (closedConns.has(f.conn)) {
            closedConns.delete(f.conn)
            await o.controllers.revoke(r.clientId).catch(() => undefined)
            o.log(`remote: a pairing finished after its connection closed and was taken back (client ${r.clientId})`)
            return
          }
          o.log(`remote: paired client ${r.clientId}`)
          return send({ t: 'redeemed', conn: f.conn, ok: true, clientId: r.clientId, token: r.token })
        }
        return send({ t: 'redeemed', conn: f.conn, ok: false, reason: r.reason })
      }
      case 'call': {
        const principal = o.controllers.principalFor(o.linkGen, f.conn)
        if (!principal)
          return send({ t: 'result', conn: f.conn, id: f.id, status: 401, body: { error: 'this connection is not authenticated', code: 'RUNTIME_AUTH_FAILED' } })
        const r = await o.orch.call({
          cmd: f.cmd,
          args: f.args,
          sessionId: '',
          from: { role: 'controller', principal, toOthers: () => {} },
          ...(f.request !== undefined ? { request: f.request } : {}),
          ...(f.retry ? { retry: true as const } : {})
        })
        // Revoked or closed while it ran: the work may have happened, but this connection gets no reply (§3.3).
        if (!o.controllers.stillBound(o.linkGen, f.conn, principal.clientId)) return
        return send({
          t: 'result',
          conn: f.conn,
          id: f.id,
          status: r.status,
          body: r.body,
          ...(r.replayed ? { replayed: true as const } : {}),
          ...(r.observed ? { observed: true as const } : {})
        })
      }
      case 'conn-closed':
        // Only a connection with a pairing in flight is remembered, and only until that pairing ends.
        if (redeeming.has(f.conn)) closedConns.add(f.conn)
        for (const s of [...subs.values()]) if (s.conn === f.conn) dropSub(s.key)
        return o.controllers.unbind(o.linkGen, f.conn)
      case 'subscribe': {
        const refuse = (code: string, message: string): void => send({ t: 'sub-error', conn: f.conn, sub: f.sub, code, message })
        if (!o.controllers.principalFor(o.linkGen, f.conn)) return refuse('RUNTIME_AUTH_FAILED', 'this connection is not authenticated')
        if (!o.ptys) return refuse('RUNTIME_CAPABILITY_MISSING', 'this Runtime does not stream pty output')
        const key = keyOf(f.conn, f.sub)
        // The same id again replaces the old subscription (a resubscribe after a gap).
        if (subs.has(key)) dropSub(key)
        if ([...subs.values()].filter((x) => x.conn === f.conn).length >= SUBS_PER_CONN)
          return refuse('RUNTIME_BUSY', `at most ${SUBS_PER_CONN} subscriptions per connection`)
        // Registered before the replay is computed, so an event in between is held, not lost (§3.7: nothing lost or
        // repeated), and sent after the replay in seq order.
        const s: Sub = { key, conn: f.conn, sub: f.sub, pty: f.pty, live: false, held: [], last: 0 }
        subs.set(key, s)
        const r = await o.ptys.replayFrom(f.pty, { ...(f.fromSeq !== undefined ? { fromSeq: f.fromSeq } : {}), ...(f.bootId !== undefined ? { bootId: f.bootId } : {}) })
        if (subs.get(key) !== s) return
        if (!r) {
          subs.delete(key)
          return refuse('RUNTIME_NOT_FOUND', `no pty ${f.pty} on this Runtime (or its output is no longer kept)`)
        }
        send({ t: 'subscribed', conn: f.conn, sub: f.sub, pty: f.pty, bootId: o.ptys.bootId })
        if (r.checkpoint && r.gap) {
          // Stream output, not control (Phase 8 review I3): a checkpoint of a thousand rows is hundreds of KB, and on
          // the control lane a few of them would trip the link's hard cap. Admitted whole on its stream, in chunks
          // when it is large; the Gateway puts them together.
          const line = JSON.stringify({ t: 'checkpoint', conn: f.conn, sub: f.sub, checkpoint: r.checkpoint, gap: r.gap })
          const parts = Buffer.byteLength(line) <= CHUNK_THRESHOLD ? [line] : chunksOf(`h${++ref}`, line).map((c) => JSON.stringify({ ...c, conn: f.conn }))
          for (const part of parts) out.stream(key, `${part}${String.fromCharCode(10)}`, r.checkpoint.watermark, { admit: true })
          s.last = r.checkpoint.watermark
        } else s.last = (f.fromSeq ?? 1) - 1
        for (const e of [...r.events, ...s.held]) push(s, e)
        s.held = []
        s.live = true
        return
      }
      case 'unsubscribe':
        return dropSub(keyOf(f.conn, f.sub))
    }
  }

  o.input.setEncoding('utf8')
  o.input.on(
    'data',
    createLineReader({
      maxLine: FRAME_CAP + 1024,
      onMessage: (v) => {
        if (detached) return
        const f = parseLinkFrame(v, 'gateway')
        if ('error' in f) {
          o.log(`remote: refused a link frame from the Gateway (${f.error})`)
          return
        }
        void onFrame(f).catch((e: unknown) => o.log(`remote: a link frame failed: ${e instanceof Error ? e.name : 'error'}`))
      },
      onBadLine: () => o.log('remote: the Gateway sent a line that is not JSON'),
      onHandlerError: () => o.log('remote: a link frame could not be handled'),
      onOverflow: () => {
        o.log('remote: the Gateway sent a line over the link cap; stopping it')
        hardCap()
      }
    })
  )

  return {
    closeConns: (conns) => {
      for (const c of conns) if (c.linkGen === o.linkGen) send({ t: 'close-conn', conn: c.conn, code: 'RUNTIME_AUTH_FAILED' })
    },
    detach: () => {
      detached = true
      stopEvents?.()
      subs.clear()
      out.destroy()
      o.controllers.dropLink(o.linkGen)
    }
  }
}

// The Host's end of the link to its Remote Gateway (remote runtime design §2.4, §3.3). The Gateway is the Host's own
// child, but it faces the network, so nothing it says is believed beyond what it can know: a connection id, a token
// hash, a pairing code, a call. Who a connection is comes from this Host's bindings and client records alone (X1-08),
// and every call runs through `createHostOrch(...).call` as a `controller`, behind the controller gate.
//
// It is not a socket client: idle exit never counts it, it holds nothing, receives no `orch-act`, no yields and no
// broadcast, and it has no route to `state-put`, `retire`, `pty-*`, `proc-*` or any app-only call (§2.4).
import type { Readable, Writable } from 'node:stream'
import { createLineReader } from './framing'
import type { ControllerRegistry } from './controllers'
import type { OrchCall } from '../core/host/orchProtocol'
import { createLaneWriter } from '../core/remote/lanes'
import { FRAME_CAP, parseLinkFrame, type GatewayLinkFrame, type HelloFrame, type HostLinkFrame } from '../core/remote/frames'

/** The control lane's hard cap (§3.1, DC-2): past it the Gateway is not reading, and it is killed. */
export const LINK_HARD_CAP = 8 << 20

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
}): GatewayLinkHandle {
  let detached = false
  let capped = false
  const hardCap = (): void => {
    if (capped) return
    capped = true
    o.onHardCap()
  }
  const out = createLaneWriter(o.output, { hardCap: o.hardCap ?? LINK_HARD_CAP, onHardCap: hardCap })
  const send = (f: HostLinkFrame): void => {
    if (!detached) out.control(`${JSON.stringify(f)}\n`)
  }

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
        // Neither the code nor the token is logged, here or anywhere (§4.7).
        const r = await o.controllers.redeem(f.code, f.name).catch((e: unknown) => {
          o.log(`remote: a pairing could not be saved: ${e instanceof Error ? e.message : String(e)}`)
          return { ok: false as const, reason: 'unsaved' as const }
        })
        if (r.ok) {
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
        return o.controllers.unbind(o.linkGen, f.conn)
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
      out.destroy()
      o.controllers.dropLink(o.linkGen)
    }
  }
}

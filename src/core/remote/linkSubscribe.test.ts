// The controller library's pty subscription (remote runtime design §3.7, Phase 8): replay then live with nothing
// repeated, a gap recovered by subscribing again from the last seq, a reconnect resubscribing with the old boot, and an
// unsubscribe that stops everything.
import { describe, it, expect } from 'vitest'
import { openRemoteLink, type RemoteTarget } from './link'
import type { RuntimeLink } from './client'
import type { HelloFrame, RemoteCheckpoint, RemotePtyEvent, SubscriptionFrame } from './frames'

const target: RemoteTarget = { runtimeId: 'rt_a', address: '10.0.0.2', port: 47831, fingerprint: 'F'.repeat(43), token: 'tok' }
const hello: HelloFrame = {
  t: 'hello', runtimeId: 'rt_a', displayName: 'Office', asteraVersion: '1.4.8', hostProtocol: 4, gatewayProtocol: 1, bootId: 'boot1',
  platform: 'win32', pathStyle: 'windows', permission: 'read-only', capabilities: ['pty.seq', 'pty.checkpoint']
}
const cp = (watermark: number): RemoteCheckpoint => ({ watermark, cols: 80, rows: 24, state: `state@${watermark}`, pending: '' })
const data = (seq: number): RemotePtyEvent => ({ seq, kind: 'data', data: `d${seq}` })

/** A Runtime whose connections record subscriptions and let the test push frames to them, or drop. */
function fakeRuntime(o: { capabilities?: string[] } = {}) {
  const asked: Array<{ conn: number; t: 'subscribe' | 'unsubscribe'; sub: string; pty?: string; fromSeq?: number; bootId?: string }> = []
  const conns: Array<{ push(f: SubscriptionFrame): void; drop(): void }> = []
  const connect = async (): Promise<RuntimeLink> => {
    const n = conns.length + 1
    let closeIt!: (v: { code?: string }) => void
    const closed = new Promise<{ code?: string }>((r) => (closeIt = r))
    const handlers = new Map<string, (f: SubscriptionFrame) => void>()
    conns.push({
      push: (f) => handlers.get(f.sub)?.(f),
      drop: () => closeIt({})
    })
    return {
      auth: async () => (o.capabilities ? { ...hello, capabilities: o.capabilities } : hello),
      redeem: async () => ({ clientId: 'c', token: 't' }),
      call: async () => ({ status: 200, body: {} }),
      subscribe: (sub, pty, o, onFrame) => {
        handlers.set(sub, onFrame)
        asked.push({ conn: n, t: 'subscribe', sub, pty, ...(o.fromSeq !== undefined ? { fromSeq: o.fromSeq } : {}), ...(o.bootId !== undefined ? { bootId: o.bootId } : {}) })
      },
      unsubscribe: (sub) => {
        handlers.delete(sub)
        asked.push({ conn: n, t: 'unsubscribe', sub })
      },
      close: () => closeIt({}),
      closed
    }
  }
  return { connect, asked, conns }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

const watch = (rt: ReturnType<typeof fakeRuntime>, slept: number[] = []) => {
  const link = openRemoteLink({ target, client: {}, connect: rt.connect, sleep: async (ms) => void slept.push(ms), random: () => 0.5 })
  const seen: string[] = []
  const stop = link.subscribe('p1', {
    onReset: (c) => seen.push(`reset@${c.watermark}`),
    onEvents: (es) => seen.push(...es.map((e) => `seq${e.seq}`)),
    onGone: (code) => seen.push(`gone:${code}`)
  })
  return { link, seen, stop }
}

describe('RemoteLink.subscribe', () => {
  it('a checkpoint resets, then events after it in order, none repeated', async () => {
    const rt = fakeRuntime()
    const w = watch(rt)
    await settle()
    const sub = rt.asked[0].sub
    expect(rt.asked[0]).toEqual({ conn: 1, t: 'subscribe', sub, pty: 'p1' })
    rt.conns[0].push({ t: 'subscribed', sub, pty: 'p1', bootId: 'boot1' })
    rt.conns[0].push({ t: 'checkpoint', sub, checkpoint: cp(4), gap: { firstSeq: 1, lastSeq: 4 } })
    rt.conns[0].push({ t: 'pty-out', sub, events: [data(4)] })
    rt.conns[0].push({ t: 'pty-out', sub, events: [data(5), data(6)] })
    rt.conns[0].push({ t: 'pty-out', sub, events: [data(6)] })
    expect(w.seen).toEqual(['reset@4', 'seq5', 'seq6'])
    w.link.close()
  })

  it('a gap subscribes again from the last seq it has, under the same boot', async () => {
    const rt = fakeRuntime()
    const w = watch(rt)
    await settle()
    const sub = rt.asked[0].sub
    rt.conns[0].push({ t: 'subscribed', sub, pty: 'p1', bootId: 'boot1' })
    rt.conns[0].push({ t: 'checkpoint', sub, checkpoint: cp(2), gap: { firstSeq: 1, lastSeq: 2 } })
    rt.conns[0].push({ t: 'pty-out', sub, events: [data(3)] })
    rt.conns[0].push({ t: 'output-gap', sub, firstSeq: 4, lastSeq: 9, code: 'OUTPUT_GAP' })
    await settle()
    expect(rt.asked[1]).toMatchObject({ t: 'subscribe', sub, pty: 'p1', fromSeq: 4, bootId: 'boot1' })
    w.link.close()
  })

  it('a reconnect subscribes every stream again from where it was, and a new checkpoint resets', async () => {
    const rt = fakeRuntime()
    const w = watch(rt)
    await settle()
    const sub = rt.asked[0].sub
    rt.conns[0].push({ t: 'subscribed', sub, pty: 'p1', bootId: 'boot1' })
    rt.conns[0].push({ t: 'checkpoint', sub, checkpoint: cp(2), gap: { firstSeq: 1, lastSeq: 2 } })
    rt.conns[0].push({ t: 'pty-out', sub, events: [data(3)] })
    rt.conns[0].drop()
    await settle()
    await settle()
    expect(rt.asked.filter((a) => a.t === 'subscribe').at(-1)).toMatchObject({ conn: 2, sub, fromSeq: 4, bootId: 'boot1' })
    // The Runtime restarted meanwhile: it answers with a checkpoint, which resets the view.
    rt.conns[1].push({ t: 'subscribed', sub, pty: 'p1', bootId: 'boot2' })
    rt.conns[1].push({ t: 'checkpoint', sub, checkpoint: cp(1), gap: { firstSeq: 1, lastSeq: 1 } })
    rt.conns[1].push({ t: 'pty-out', sub, events: [data(2)] })
    expect(w.seen).toEqual(['reset@2', 'seq3', 'reset@1', 'seq2'])
    w.link.close()
  })

  it('unsubscribe tells the Runtime and stops the callbacks', async () => {
    const rt = fakeRuntime()
    const w = watch(rt)
    await settle()
    const sub = rt.asked[0].sub
    w.stop()
    expect(rt.asked.at(-1)).toEqual({ conn: 1, t: 'unsubscribe', sub })
    rt.conns[0].push({ t: 'pty-out', sub, events: [data(1)] })
    expect(w.seen).toEqual([])
    w.link.close()
  })

  it('a refused subscription is gone, with its code, and not tried again', async () => {
    const rt = fakeRuntime()
    const w = watch(rt)
    await settle()
    const sub = rt.asked[0].sub
    rt.conns[0].push({ t: 'sub-error', sub, code: 'RUNTIME_NOT_FOUND', message: 'no such pty' })
    await settle()
    expect(w.seen).toEqual(['gone:RUNTIME_NOT_FOUND'])
    rt.conns[0].drop()
    await settle()
    expect(rt.asked.filter((a) => a.t === 'subscribe')).toHaveLength(1)
    w.link.close()
  })

  // Phase 8 review I4: a Runtime from before Phase 8 has no subscriptions; asking anyway would close the connection
  // and loop. The capability is checked first, and repeated drops wait longer each time.
  it('a Runtime without pty.seq and pty.checkpoint is gone at once, with nothing sent', async () => {
    const rt = fakeRuntime({ capabilities: ['remote.jobs'] })
    const w = watch(rt)
    await settle()
    expect(w.seen).toEqual(['gone:RUNTIME_CAPABILITY_MISSING'])
    expect(rt.asked).toEqual([])
    w.link.close()
  })

  it('a connection that keeps dropping before the subscription is answered waits longer each time', async () => {
    const rt = fakeRuntime()
    const slept: number[] = []
    const w = watch(rt, slept)
    for (let i = 0; i < 4; i++) {
      await settle()
      rt.conns.at(-1)?.drop()
    }
    await settle()
    expect(slept.length).toBeGreaterThanOrEqual(3)
    expect(slept[2]).toBeGreaterThan(slept[0])
    w.link.close()
  })
})

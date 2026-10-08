// Remote Runtime Phase 8 acceptance in one process (remote runtime design §3.7, X1-02): a pty registry with a fake pty,
// the Host's end of the Gateway link, the Gateway on real pinned TLS, and a controller that pairs and subscribes through
// the controller library. The controller's view (a terminal fed the checkpoint, its pending text and the events after
// it) must equal a reference terminal fed every byte, across disconnections that force a checkpoint.
import { describe, it, expect, afterEach } from 'vitest'
import { PassThrough } from 'node:stream'
import { generateKeyPairSync } from 'node:crypto'
import { Terminal } from '@xterm/headless'
import { PtyRegistry, type RegistryPty } from './registry'
import { attachGatewayLink, type GatewayLinkHandle } from './gatewayLink'
import { createControllerRegistry } from './controllers'
import { TERMINAL_SCROLLBACK } from './liveTerminal'
import { buildCertificate, certificatePem, spkiSha256 } from '../core/remote/cert'
import { connectRuntime, type RuntimeLink } from '../core/remote/client'
import { openRemoteLink, type RemoteLink } from '../core/remote/link'
import type { RemoteCheckpoint, RemotePtyEvent } from '../core/remote/frames'
import { startGateway, type GatewayHandle } from '../cli/runtime/gateway'

const identity = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    certPem: certificatePem(buildCertificate({ privateKey, publicKey, runtimeId: 'rt_p8', san: '127.0.0.1', now: new Date() })),
    spkiSha256: spkiSha256(publicKey)
  }
})()
const HELLO = {
  runtimeId: 'rt_p8',
  displayName: 'Office',
  asteraVersion: '9.9.9',
  hostProtocol: 4,
  gatewayProtocol: 1,
  bootId: 'boot-p8',
  platform: process.platform,
  pathStyle: 'windows' as const,
  capabilities: ['pty.seq', 'pty.checkpoint']
}
const ESC = String.fromCharCode(27)
const CRLF = String.fromCharCode(13, 10)
const BEL = String.fromCharCode(7)

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

const write = (t: Terminal, d: string): Promise<void> => new Promise((r) => t.write(d, r))

/** What a person sees: both buffers' rows with each cell's colour, which buffer is active, the cursor, the size. */
function look(t: Terminal): unknown {
  const rows = (b: typeof t.buffer.normal): string[] => {
    const out: string[] = []
    for (let y = 0; y < b.length; y++) {
      const line = b.getLine(y)
      let cells = ''
      for (let x = 0; line && x < t.cols; x++) {
        const c = line.getCell(x)
        if (c && c.getFgColor() !== 0) cells += `${x}:${c.getFgColor()},`
      }
      out.push(`${line?.translateToString(true) ?? ''}|${cells}`)
    }
    while (out.length > 0 && out[out.length - 1] === '|') out.pop()
    return out
  }
  return { active: t.buffer.active.type, cursor: [t.buffer.active.cursorX, t.buffer.active.cursorY], size: [t.cols, t.rows], normal: rows(t.buffer.normal), alternate: rows(t.buffer.alternate) }
}

/** The Runtime: a registry with one fake pty, the link, the Gateway; and a reference terminal fed every byte. */
async function runtime(o: { scrollback?: number; now?: () => number } = {}) {
  let emitData: (d: string) => void = () => {}
  let emitExit: (e: { exitCode: number }) => void = () => {}
  const pty: RegistryPty = {
    pid: 1,
    onData: (cb) => void (emitData = cb),
    onExit: (cb) => void (emitExit = cb),
    write: () => {},
    resize: () => {},
    kill: () => {},
    pause: () => {},
    resume: () => {}
  }
  const registry = new PtyRegistry({ spawn: () => pty, log: () => {}, bootId: 'boot-p8', ...(o.scrollback ? { scrollback: o.scrollback } : {}), ...(o.now ? { now: o.now } : {}) })
  registry.open({ id: 'p1', file: 'sh', args: [], opts: { cwd: '.', cols: 40, rows: 8, env: {} } })
  const reference = new Terminal({ cols: 40, rows: 8, scrollback: TERMINAL_SCROLLBACK, allowProposedApi: true })
  let refChain = Promise.resolve()
  const controllers = createControllerRegistry()
  const toHost = new PassThrough()
  const fromHost = new PassThrough()
  const link: GatewayLinkHandle = attachGatewayLink({
    linkGen: 1,
    input: toHost,
    output: fromHost,
    controllers,
    orch: { call: async () => ({ status: 200, body: {} }) },
    hello: () => HELLO,
    log: () => {},
    onReady: () => {},
    onFailed: () => {},
    onHardCap: () => {},
    ptys: registry
  })
  const started = await startGateway({ identity, listen: '127.0.0.1', port: 0, link: { input: fromHost, output: toHost } })
  if ('error' in started) throw new Error(started.error.message)
  const gw: GatewayHandle = started
  cleanups.push(async () => {
    link.detach()
    await gw.close()
    reference.dispose()
  })
  return {
    registry,
    port: gw.port,
    controllers,
    out: (d: string) => {
      emitData(d)
      refChain = refChain.then(() => write(reference, d))
    },
    resize: (cols: number, rows: number) => {
      registry.resize('p1', cols, rows)
      refChain = refChain.then(() => reference.resize(cols, rows))
    },
    exit: (code: number) => emitExit({ exitCode: code }),
    reference: async () => {
      await refChain
      return look(reference)
    }
  }
}

/** A paired controller subscribed to p1. `offline()` drops its connection and holds the reconnect until `online()`. */
async function controller(rt: Awaited<ReturnType<typeof runtime>>) {
  const pairing = rt.controllers.createPairing({ permission: 'read-only' })
  const first = await connectRuntime({ host: '127.0.0.1', port: rt.port, pin: identity.spkiSha256 })
  const paired = await first.redeem(pairing.code, 'laptop', {})
  first.close()
  let current: RuntimeLink | null = null
  let gate: Promise<void> | null = null
  let open: () => void = () => {}
  const link: RemoteLink = openRemoteLink({
    target: { runtimeId: 'rt_p8', address: '127.0.0.1', port: rt.port, fingerprint: identity.spkiSha256, token: paired.token },
    client: { surface: 'desktop' },
    connect: async (c) => {
      if (gate) await gate
      current = await connectRuntime(c)
      return current
    },
    sleep: async () => {},
    random: () => 0.5
  })
  let view: Terminal | null = null
  let chain = Promise.resolve()
  const resets: RemoteCheckpoint[] = []
  const seen: RemotePtyEvent[] = []
  const stop = link.subscribe('p1', {
    onReset: (cp) => {
      resets.push(cp)
      chain = chain.then(async () => {
        view?.dispose()
        view = new Terminal({ cols: cp.cols, rows: cp.rows, scrollback: TERMINAL_SCROLLBACK, allowProposedApi: true })
        await write(view, cp.state)
        await write(view, cp.pending)
      })
    },
    onEvents: (events) => {
      seen.push(...events)
      chain = chain.then(async () => {
        for (const e of events) {
          if (!view) continue
          if (e.kind === 'data') await write(view, e.data)
          else if (e.kind === 'resize') view.resize(e.cols, e.rows)
        }
      })
    }
  })
  cleanups.push(() => {
    stop()
    link.close()
    view?.dispose()
  })
  const lastSeq = (): number => Math.max(resets.at(-1)?.watermark ?? 0, seen.at(-1)?.seq ?? 0)
  return {
    resets,
    seen,
    lastSeq,
    /** Waits until the view has everything up to `seq`, then answers what it shows. */
    view: async (seq: number) => {
      const end = Date.now() + 10_000
      while (lastSeq() < seq) {
        if (Date.now() > end) throw new Error(`the view stopped at seq ${lastSeq()}, waiting for ${seq}`)
        await new Promise((r) => setTimeout(r, 10))
      }
      await chain
      return view ? look(view) : null
    },
    /** Drops the connection and waits until it is closed: output from here on is missed, as in a real outage. */
    offline: async () => {
      gate = new Promise((r) => (open = r))
      const was = current
      was?.close()
      await was?.closed
    },
    online: () => {
      gate = null
      open()
    }
  }
}

const lastSeqOf = (rt: Awaited<ReturnType<typeof runtime>>): Promise<number> =>
  rt.registry.replayFrom('p1', {}).then((r) => (r ? Math.max(r.checkpoint?.watermark ?? 0, r.events.at(-1)?.seq ?? 0) : 0))

describe('Remote Runtime Phase 8 acceptance (design §6 Phase 8, X1-02)', { timeout: 60_000 }, () => {
  it('a header painted before the ring’s first event is on the subscribed screen', async () => {
    const rt = await runtime({ scrollback: 2_000 })
    rt.out(`${ESC}[1;33mHEADER${ESC}[0m${CRLF}`)
    for (let i = 0; i < 200; i++) rt.out(`line ${i}${CRLF}`)
    const c = await controller(rt)
    rt.out('after')
    expect(await c.view(await lastSeqOf(rt))).toEqual(await rt.reference())
  })

  it('a split CSI and a split OSC across a drop that forces a checkpoint', async () => {
    const rt = await runtime({ scrollback: 2_000 })
    const c = await controller(rt)
    rt.out('start ')
    await c.view(await lastSeqOf(rt))
    await c.offline()
    for (let i = 0; i < 100; i++) rt.out(`filler ${i}${CRLF}`)
    rt.out(`${ESC}]0;ti`)
    rt.out(`tle${BEL}plain ${ESC}[3`)
    c.online()
    // The rest of the CSI only after the reconnect's checkpoint arrived, so that checkpoint is taken inside it.
    const end = Date.now() + 10_000
    while (c.resets.length < 2) {
      if (Date.now() > end) throw new Error('no checkpoint after the reconnect')
      await new Promise((r) => setTimeout(r, 10))
    }
    rt.out(`1mred${ESC}[0m end`)
    expect(await c.view(await lastSeqOf(rt))).toEqual(await rt.reference())
    // The ring no longer held where the view left off, so it recovered through a checkpoint taken inside the CSI.
    expect(c.resets.length).toBeGreaterThanOrEqual(2)
    expect(c.resets.at(-1)?.pending).toBe(`${ESC}[3`)
  })

  it('an alternate-screen program painted while disconnected', async () => {
    const rt = await runtime({ scrollback: 2_000 })
    const c = await controller(rt)
    rt.out(`shell$ vim${CRLF}`)
    await c.view(await lastSeqOf(rt))
    await c.offline()
    rt.out(`${ESC}[?1049h${ESC}[H${ESC}[2J`)
    for (let i = 0; i < 60; i++) rt.out(`~ ${i}${CRLF}`)
    rt.out(`${ESC}[7mstatus${ESC}[0m`)
    c.online()
    expect(await c.view(await lastSeqOf(rt))).toEqual(await rt.reference())
  })

  it('a resize while disconnected keeps the width of rows painted before it', async () => {
    const rt = await runtime()
    const c = await controller(rt)
    rt.out('0123456789012345678901234567890123456789abc')
    await c.view(await lastSeqOf(rt))
    await c.offline()
    rt.out(CRLF)
    rt.resize(20, 6)
    rt.out('after the resize, a long line that wraps')
    c.online()
    expect(await c.view(await lastSeqOf(rt))).toEqual(await rt.reference())
  })

  it('an exit while disconnected reaches the view, and output after it', async () => {
    const rt = await runtime({ scrollback: 1_000 })
    const c = await controller(rt)
    rt.out('working')
    await c.view(await lastSeqOf(rt))
    await c.offline()
    for (let i = 0; i < 40; i++) rt.out(`last words ${i}${CRLF}`)
    rt.exit(2)
    rt.out('late')
    c.online()
    expect(await c.view(await lastSeqOf(rt))).toEqual(await rt.reference())
    expect(c.resets.at(-1)?.exitCode === 2 || c.seen.some((e) => e.kind === 'exit' && e.code === 2)).toBe(true)
  })

  it('output after exit is replayable for 10 minutes and is gone after', async () => {
    let t = 0
    const rt = await runtime({ now: () => t })
    rt.out('the end')
    rt.exit(0)
    t = 9 * 60_000
    const c = await controller(rt)
    expect(await c.view(await lastSeqOf(rt))).toEqual(await rt.reference())
    t = 11 * 60_000
    rt.registry.sweepExited()
    expect(await rt.registry.replayFrom('p1', {})).toBeNull()
  })
})

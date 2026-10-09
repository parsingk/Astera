import { describe, it, expect, vi } from 'vitest'
import type { RunContext } from '../agentBrowser/scriptRunner'
import { clickScript, snapshotScript } from '../agentBrowser/guestScripts'
import type { DeskWindow } from './protocol'
import { LAUNCH_WAIT_MAX_MS } from './script'
import {
  CDP_WAIT_MS,
  DRAG_CDP_MS,
  LAYOUT_TRIES,
  NO_CDP,
  PAGE_READY_MS,
  cdpKeyEvents,
  insideViewport,
  launchEnv,
  parseLaunchSpec,
  pngSize,
  windowPoint,
  workspaceHelpers,
  type AppState,
  type Cdp,
  type Desk,
  type DeskPointer,
  type HelperDeps,
  type WindowPoint
} from './helpers'

const png = (w: number, h: number): string => {
  const b = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return b.toString('base64')
}

class FakeCdp implements Cdp {
  calls: Array<{ method: string; params?: Record<string, unknown> }> = []
  answers = new Map<string, (p?: Record<string, unknown>) => Record<string, unknown>>()
  events = new Map<string, Record<string, unknown>>()
  errors: string[] = []
  closed = false
  async send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push({ method, params })
    const a = this.answers.get(method)
    return a ? a(params) : {}
  }
  async waitEvent(method: string, _timeoutMs?: number): Promise<Record<string, unknown>> {
    const e = this.events.get(method)
    if (!e) throw new Error(`${method} did not arrive`)
    return e
  }
  consoleErrors(): string[] {
    return [...this.errors]
  }
  close(): void {
    this.closed = true
  }
  /** Runtime.evaluate answers in the order given. */
  evaluates(...values: unknown[]): void {
    this.answers.set('Runtime.evaluate', () => ({ result: { value: values.shift() } }))
  }
}

const WINDOWS: DeskWindow[] = [
  { hwnd: 1, title: 'Fixture', className: 'Chrome_WidgetWin_1', pid: 501, width: 800, height: 600, visible: true },
  { hwnd: 2, title: '', className: 'Hidden', pid: 501, width: 0, height: 0, visible: false }
]

class FakeDesk implements Desk {
  pointer?: DeskPointer
  name = 'astera-ws-test'
  launches: Array<{ command: string; cwd: string; env: Record<string, string> }> = []
  kills: Array<[number, number]> = []
  keyCalls: Array<{ title: string; text?: string; key?: string }> = []
  shotCalls: Array<{ title?: string; format: 'png' | 'jpeg'; maxWidth?: number }> = []
  async launch(a: { command: string; cwd: string; env: Record<string, string> }) {
    this.launches.push(a)
    return { pid: 500 + this.launches.length, startedAt: 1_000 }
  }
  async kill(pid: number, startedAt: number) {
    this.kills.push([pid, startedAt])
  }
  async windows() {
    return WINDOWS
  }
  async shot(a: { title?: string; format: 'png' | 'jpeg'; maxWidth?: number }) {
    this.shotCalls.push(a)
    return { data: png(800, 600), width: 800, height: 600, title: 'Fixture' }
  }
  async keys(a: { title: string; text?: string; key?: string }) {
    this.keyCalls.push(a)
  }
  async close() {}
}

const rig = (over: Partial<HelperDeps> = {}) => {
  const cdp = new FakeCdp()
  const desk = new FakeDesk()
  const state: AppState = { launched: null, cdp: null }
  let opened: Desk | null = null
  const deps: HelperDeps = {
    state,
    desk: async () => (opened = desk),
    deskIfOpen: () => opened,
    resolveLaunch: vi.fn(async () => ({ command: 'npm run dev', cwd: 'C:/proj', env: { PATH: 'x' } })),
    freePort: async () => 9333,
    connectCdp: vi.fn(async () => cdp),
    saveCapture: vi.fn(async () => 'C:/shots/app-1.png'),
    recordLaunch: vi.fn(),
    changed: vi.fn(),
    cleanup: vi.fn(async () => {}),
    launchWait: () => ({ leftMs: 100_000, end: () => {} }),
    now: () => 0,
    stopped: () => false,
    guide: '# guide\n\n## launch(spec)\nStarts it.\n\n## windows()\nLists them.\n',
    ...over
  }
  const ctx: RunContext = { at: 'script' }
  const h = workspaceHelpers(deps, ctx) as Record<string, (...a: unknown[]) => Promise<unknown>>
  return { cdp, desk, state, deps, ctx, h }
}

describe('launch', () => {
  it('runs the configuration on the desktop with the port in its environment, then connects', async () => {
    const r = rig()
    expect(await r.h.launch({ config: 'Electron dev' })).toEqual({ pid: 501, port: 9333 })
    expect(r.deps.resolveLaunch).toHaveBeenCalledWith({ config: 'Electron dev' })
    expect(r.desk.launches[0]).toEqual({ command: 'npm run dev', cwd: 'C:/proj', env: { PATH: 'x', ASTERA_APP_CDP_PORT: '9333' } })
    expect(r.state.launched).toMatchObject({ pid: 501, port: 9333, spec: { config: 'Electron dev' } })
    expect(r.deps.recordLaunch).toHaveBeenCalledWith(r.state.launched)
    expect(r.deps.connectCdp).toHaveBeenCalledWith(9333, 60_000)
    expect(r.state.cdp).toBe(r.cdp)
    expect(r.deps.changed).toHaveBeenCalled()
  })

  it('asks the manager to size the window once the page has settled, and when the port never opens', async () => {
    const order: string[] = []
    const r = rig({ started: vi.fn(async () => void order.push('started')) })
    r.cdp.answers.set('Runtime.evaluate', () => (order.push('settled?'), { result: { value: true } }))
    await r.h.launch({ command: 'app.exe' })
    expect(order).toEqual(['settled?', 'started'])
    const noPort = rig({ started: vi.fn(async () => {}), connectCdp: vi.fn(async () => null) })
    await expect(noPort.h.launch({ command: 'app.exe' })).rejects.toThrow('nothing answered')
    expect(noPort.deps.started).toHaveBeenCalledTimes(1)
  })

  it('is refused once launched, and says to relaunch', async () => {
    const r = rig()
    await r.h.launch({ command: 'app.exe' })
    await expect(r.h.launch({ command: 'app.exe' })).rejects.toThrow('relaunch()')
  })

  it('refuses a spec that is neither a configuration nor a command', async () => {
    await expect(rig().h.launch({})).rejects.toThrow("pass { config:")
    expect(() => parseLaunchSpec({ config: 'a', command: 'b' })).toThrow()
    expect(parseLaunchSpec({ command: 'x', cwd: 'sub' })).toEqual({ command: 'x', cwd: 'sub' })
  })

  it('waits for the port no longer than the launch wait may last, minus a margin (ruling P1)', async () => {
    const r = rig({ launchWait: () => ({ leftMs: 10_000, end: () => {} }), now: () => 0 })
    await r.h.launch({ command: 'app.exe' }, { waitMs: 60_000 })
    expect(r.deps.connectCdp).toHaveBeenCalledWith(9333, 8_000)
  })

  // Stage 4, task 2: a first dev build can take longer than a script may run. The wait is a launch
  // wait, which the script's deadline does not count, so launch may ask for up to LAUNCH_WAIT_MAX_MS.
  it('honours a waitMs above the default, up to LAUNCH_WAIT_MAX_MS, and waits 90 s when the port takes that long', async () => {
    let t = 0
    const end = vi.fn()
    const launchWait = vi.fn(() => ({ leftMs: LAUNCH_WAIT_MAX_MS + 60_000, end }))
    const r = rig({
      launchWait,
      now: () => t,
      connectCdp: vi.fn(async (_port: number, waitMs: number) => {
        // The port answers after 90 s, inside what was asked for.
        t += 90_000
        return 90_000 <= waitMs ? r.cdp : null
      })
    })
    expect(await r.h.launch({ command: 'app.exe' }, { waitMs: 120_000 })).toEqual({ pid: 501, port: 9333 })
    expect(r.deps.connectCdp).toHaveBeenCalledWith(9333, 120_000)
    expect(launchWait).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledTimes(1)

    const big = rig({ launchWait: () => ({ leftMs: LAUNCH_WAIT_MAX_MS * 2, end: () => {} }) })
    await big.h.launch({ command: 'app.exe' }, { waitMs: 3_600_000 })
    expect(big.deps.connectCdp).toHaveBeenCalledWith(9333, LAUNCH_WAIT_MAX_MS)
    const plain = rig({ launchWait: () => ({ leftMs: LAUNCH_WAIT_MAX_MS * 2, end: () => {} }) })
    await plain.h.launch({ command: 'app.exe' })
    expect(plain.deps.connectCdp).toHaveBeenCalledWith(9333, CDP_WAIT_MS)
  })

  it('a launch stopped by the time its port wait would begin waits for nothing, and says it was stopped', async () => {
    let stopped = false
    const end = vi.fn()
    const r = rig({
      stopped: () => stopped,
      launchWait: () => {
        stopped = true
        return { leftMs: 0, end }
      }
    })
    await expect(r.h.launch({ command: 'app.exe' })).rejects.toThrow('launch: stopped')
    expect(r.deps.connectCdp).not.toHaveBeenCalled()
    expect(r.state.launched?.pid).toBe(501)
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('a launch stopped while its port wait ran keeps the connection but does not wait for the page', async () => {
    let stopped = false
    const r = rig({ stopped: () => stopped })
    r.deps.connectCdp = vi.fn(async () => {
      stopped = true
      return r.cdp
    })
    r.cdp.evaluates(...Array.from({ length: 100 }, () => false))
    await expect(r.h.launch({ command: 'app.exe' })).rejects.toThrow('launch: stopped')
    expect(r.state.cdp).toBe(r.cdp)
    expect(r.cdp.calls.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(0)
  })

  it('ends its launch wait whether the port opens or not, and relaunch takes a longer waitMs as launch does', async () => {
    const end = vi.fn()
    const failed = rig({ launchWait: () => ({ leftMs: 100_000, end }), connectCdp: vi.fn(async () => null) })
    await expect(failed.h.launch({ command: 'app.exe' })).rejects.toThrow('debugging port')
    expect(end).toHaveBeenCalledTimes(1)
    const relaunched = rig({ launchWait: () => ({ leftMs: 100_000, end }) })
    await relaunched.h.launch({ command: 'app.exe' })
    await relaunched.h.relaunch({ waitMs: 200_000 })
    expect(relaunched.deps.connectCdp).toHaveBeenLastCalledWith(9333, 100_000 - 2_000)
    expect(end).toHaveBeenCalledTimes(3)
  })

  it('a stop that lands before the desktop, or before the launch, starts neither (ruling F1)', async () => {
    const before = rig({ stopped: () => true })
    await expect(before.h.launch({ command: 'app.exe' })).rejects.toThrow('launch: stopped')
    expect(before.deps.deskIfOpen()).toBeNull()
    expect(before.desk.launches).toEqual([])

    let stopped = false
    const desk = new FakeDesk()
    const during = rig({
      stopped: () => stopped,
      desk: async () => {
        stopped = true
        return desk
      }
    })
    await expect(during.h.launch({ command: 'app.exe' })).rejects.toThrow('launch: stopped')
    expect(desk.launches).toEqual([])
    expect(during.state.launched).toBeNull()
    expect(during.deps.recordLaunch).not.toHaveBeenCalled()
  })

  // Measured by the real desktop e2e (Task 10): the page target answers while its document is still
  // parsing, and a snapshot() straight after launch() threw on a null document.body.
  it('returns only once the page has finished parsing, so the next helper finds a document', async () => {
    const r = rig()
    r.cdp.evaluates(false, false, true)
    await r.h.launch({ command: 'app.exe' })
    const polls = r.cdp.calls.filter((c) => c.method === 'Runtime.evaluate')
    expect(polls).toHaveLength(3)
    expect(String(polls[0].params?.expression)).toContain("document.readyState !== 'loading'")
    expect(String(polls[0].params?.expression)).toContain("'about:blank'")
  })

  it('a poll that fails (the page navigating) is asked again', async () => {
    const r = rig()
    let n = 0
    r.cdp.answers.set('Runtime.evaluate', () => {
      n++
      if (n === 1) throw new Error('Execution context was destroyed')
      return { result: { value: true } }
    })
    await r.h.launch({ command: 'app.exe' })
    expect(n).toBe(2)
  })

  it('a page that never settles holds launch no longer than PAGE_READY_MS, then launch succeeds', async () => {
    let t = 0
    const r = rig({ now: () => (t += 1_000), launchWait: () => ({ leftMs: 1_000_000, end: () => {} }) })
    r.cdp.evaluates(...Array.from({ length: 100 }, () => false))
    expect(await r.h.launch({ command: 'app.exe' })).toEqual({ pid: 501, port: 9333 })
    const polls = r.cdp.calls.filter((c) => c.method === 'Runtime.evaluate').length
    expect(polls).toBeGreaterThan(1)
    expect(polls).toBeLessThanOrEqual(PAGE_READY_MS / 1_000 + 1)
  })

  it('a port that never opens fails launch with the hint, and the native helpers still work', async () => {
    const r = rig({ connectCdp: vi.fn(async () => null) })
    await expect(r.h.launch({ command: 'app.exe' })).rejects.toThrow('--remote-debugging-port=%ASTERA_APP_CDP_PORT%')
    expect(r.state.launched?.pid).toBe(501)
    expect(await r.h.windows()).toEqual([{ title: 'Fixture', className: 'Chrome_WidgetWin_1', pid: 501, width: 800, height: 600 }])
    await expect(r.h.snapshot()).rejects.toThrow(NO_CDP)
  })

  it('names the port variable in sh syntax off Windows, and on macOS says only the page can be driven (R12)', async () => {
    const linux = rig({ connectCdp: vi.fn(async () => null), platform: 'linux' })
    await expect(linux.h.launch({ command: 'app' })).rejects.toThrow('--remote-debugging-port=$ASTERA_APP_CDP_PORT (for example')
    await expect(linux.h.launch({ command: 'app' })).rejects.toThrow('already launched')
    const mac = rig({ connectCdp: vi.fn(async () => null), platform: 'darwin' })
    const err = await mac.h.launch({ command: 'app' }).catch((e: Error) => e.message)
    expect(err).toContain('--remote-debugging-port=$ASTERA_APP_CDP_PORT')
    expect(err).toContain('on macOS only its page can be driven')
    expect(err).not.toContain('windowShot() and keys() work')
  })
})

describe('relaunch and close', () => {
  it('relaunch kills the tree (by pid and launch start time), drops the old connection, and starts the same spec again', async () => {
    const r = rig()
    await r.h.launch({ config: 'dev' })
    const first = r.cdp
    await r.h.relaunch()
    expect(r.desk.kills).toEqual([[501, 1_000]])
    expect(first.closed).toBe(true)
    expect(r.desk.launches).toHaveLength(2)
    expect(r.state.launched?.pid).toBe(502)
    expect(r.deps.recordLaunch).toHaveBeenCalledWith(null)
  })

  // Final review Important 1: a stopped launch still waiting on the port must not overwrite the
  // connection a later relaunch (or close then launch) set, and must not leak it.
  for (const late of ['null', 'a stale socket'] as const) {
    it(`a launch whose app was replaced while it waited for the port drops its late result (${late}) and fails as stopped`, async () => {
      let resolveWait!: (c: Cdp | null) => void
      const r = rig({ connectCdp: vi.fn(() => new Promise<Cdp | null>((res) => (resolveWait = res))) })
      const first = r.h.launch({ command: 'app.exe' })
      await vi.waitFor(() => expect(resolveWait).toBeTypeOf('function'))
      // A newer script relaunched: the manager's state now holds another app and its connection.
      const newer = new FakeCdp()
      const replacement = { pid: 777, startedAt: 5_000, port: 9444, spec: { command: 'app.exe' } }
      r.state.launched = replacement
      r.state.cdp = newer
      const stale = new FakeCdp()
      resolveWait(late === 'null' ? null : stale)
      await expect(first).rejects.toThrow('launch: stopped')
      expect(r.state.cdp).toBe(newer)
      expect(r.state.launched).toBe(replacement)
      expect(newer.closed).toBe(false)
      if (late === 'a stale socket') expect(stale.closed).toBe(true)
    })
  }

  it('relaunch before launch is refused', async () => {
    await expect(rig().h.relaunch()).rejects.toThrow('call launch() first')
  })

  it('close hands the cleanup to the manager', async () => {
    const r = rig()
    await r.h.close()
    expect(r.deps.cleanup).toHaveBeenCalledTimes(1)
  })
})

describe('the page helpers', () => {
  it('say nothing is launched before launch', async () => {
    const r = rig()
    await expect(r.h.snapshot()).rejects.toThrow('nothing launched')
    await expect(r.h.windows()).rejects.toThrow('windows: nothing launched')
  })

  it('snapshot and url evaluate in the page', async () => {
    const r = rig()
    await r.h.launch({ command: 'app.exe' })
    r.cdp.calls = [] // the launch's own readiness poll
    r.cdp.evaluates({ title: 'T', url: 'app://x', headings: [], interactive: [], landmarks: [], text: '' }, 'app://x/')
    const snap = (await r.h.snapshot()) as { title: string }
    expect(snap.title).toBe('T')
    expect(r.cdp.calls.find((c) => c.method === 'Runtime.evaluate')?.params).toMatchObject({ expression: snapshotScript(), awaitPromise: true, returnByValue: true })
    expect(await r.h.url()).toBe('app://x/')
  })

  it('a page that throws is reported as the page throwing', async () => {
    const r = rig()
    await r.h.launch({ command: 'app.exe' })
    r.cdp.answers.set('Runtime.evaluate', () => ({ exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: x' } } }))
    await expect(r.h.url()).rejects.toThrow('url: the page threw (ReferenceError: x)')
  })

  it('click follows links, reports a miss and a disabled control, and marks the screen changed', async () => {
    const r = rig()
    await r.h.launch({ command: 'app.exe' })
    r.cdp.calls = [] // the launch's own readiness poll
    r.cdp.evaluates({ found: true, clicked: true }, { found: false }, { found: true, disabled: true })
    await r.h.click('#go')
    expect(r.cdp.calls.filter((c) => c.method === 'Runtime.evaluate')[0].params?.expression).toBe(clickScript('#go', true))
    await expect(r.h.click('#nope')).rejects.toThrow('click: nothing matches #nope')
    await expect(r.h.click('#off')).rejects.toThrow('click: #off is disabled')
    expect(r.deps.changed).toHaveBeenCalledTimes(2)
  })

  it('consoleErrors returns what the connection collected', async () => {
    const r = rig()
    await r.h.launch({ command: 'app.exe' })
    r.cdp.errors.push('TypeError: boom')
    expect(await r.h.consoleErrors()).toEqual(['TypeError: boom'])
  })
})

describe('keys through CDP', () => {
  it('press sends a trusted key down and up', async () => {
    const r = rig()
    await r.h.launch({ command: 'app.exe' })
    await r.h.press('Enter')
    const keys = r.cdp.calls.filter((c) => c.method === 'Input.dispatchKeyEvent').map((c) => c.params)
    expect(keys).toEqual([
      { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
      { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }
    ])
    await expect(r.h.press('Hyper')).rejects.toThrow('press: unknown key Hyper')
  })

  it('cdpKeyEvents maps a letter, a digit and a named key without text', () => {
    expect(cdpKeyEvents('a')[0]).toEqual({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' })
    expect(cdpKeyEvents('7')[0]).toMatchObject({ code: 'Digit7', windowsVirtualKeyCode: 55 })
    expect(cdpKeyEvents('ArrowDown')[0]).toEqual({ type: 'rawKeyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 })
  })

  it('paste is a real paste command with Ctrl held', async () => {
    const r = rig()
    await r.h.launch({ command: 'app.exe' })
    await r.h.paste()
    const keys = r.cdp.calls.filter((c) => c.method === 'Input.dispatchKeyEvent').map((c) => c.params)
    expect(keys[0]).toMatchObject({ type: 'rawKeyDown', key: 'v', modifiers: 2, commands: ['paste'] })
    expect(keys[1]).toMatchObject({ type: 'keyUp', key: 'v', modifiers: 2 })
  })
})

describe('drag and drop inside the page', () => {
  it('drag intercepts the drag the press starts and drops its data on the target', async () => {
    const r = rig()
    await r.h.launch({ command: 'app.exe' })
    r.cdp.evaluates({ x: 10, y: 20 }, { x: 300, y: 400 })
    const data = { items: [{ mimeType: 'text/plain', data: 'card-1' }], dragOperationsMask: 1 }
    r.cdp.events.set('Input.dragIntercepted', { data })
    await r.h.drag('#card', '#column')
    const seq = r.cdp.calls.filter((c) => c.method !== 'Runtime.evaluate').map((c) => `${c.method}:${String(c.params?.type ?? c.params?.enabled)}`)
    expect(seq).toEqual([
      'Input.setInterceptDrags:true',
      'Input.dispatchMouseEvent:mousePressed',
      'Input.dispatchMouseEvent:mouseMoved',
      'Input.dispatchDragEvent:dragEnter',
      'Input.dispatchDragEvent:dragOver',
      'Input.dispatchDragEvent:drop',
      'Input.dispatchMouseEvent:mouseReleased',
      'Input.setInterceptDrags:false'
    ])
    expect(r.cdp.calls.find((c) => c.params?.type === 'drop')?.params).toMatchObject({ x: 300, y: 400, data })
  })

  it('a source that does not start a drag is named, and the mouse is still released', async () => {
    const r = rig()
    await r.h.launch({ command: 'app.exe' })
    r.cdp.evaluates({ x: 1, y: 1 }, { x: 2, y: 2 })
    await expect(r.h.drag('#plain', '#column')).rejects.toThrow('drag: #plain did not start a drag')
    expect(r.cdp.calls.some((c) => c.params?.type === 'mouseReleased')).toBe(true)
  })

  /** A desk with a pointer of its own (Linux), and a CDP whose first drag wait gets nothing: the CDP
   *  press was ended before its move. `realStarts` says whether the real press starts the drag. */
  const fallbackRig = (realStarts: boolean) => {
    const r = rig()
    const data = { items: [{ mimeType: 'text/plain', data: 'card-1' }], dragOperationsMask: 1 }
    const presses: Array<{ title: string; from: WindowPoint; to: WindowPoint }> = []
    let releases = 0
    let waits = 0
    const pointer: DeskPointer = {
      press: async (a) => {
        presses.push(a)
      },
      release: async () => {
        releases++
      }
    }
    r.desk.pointer = pointer
    r.cdp.waitEvent = async (method: string, ms?: number) => {
      r.cdp.calls.push({ method: `wait:${method}`, params: { ms } })
      waits++
      if (waits === 1) throw new Error('timed out')
      // The second wait is armed before the real press and settles after it.
      await vi.waitFor(() => expect(presses).toHaveLength(1))
      if (!realStarts) throw new Error('timed out')
      return { data }
    }
    return { r, data, presses, releases: () => releases }
  }

  it('on a desk with its own pointer, drags with it when the CDP press starts no drag, then drops and lets go', async () => {
    const f = fallbackRig(true)
    await f.r.h.launch({ command: 'app' })
    f.r.cdp.evaluates({ x: 10, y: 20 }, { x: 300, y: 400 }, { title: 'Fixture', offX: 0, offY: 28, dpr: 2 })
    await f.r.h.drag('#card', '#column')
    expect(f.presses).toEqual([{ title: 'Fixture', from: { x: 20, y: 96 }, to: { x: 600, y: 856 } }])
    expect(f.releases()).toBe(1)
    const seq = f.r.cdp.calls
      .filter((c) => c.method !== 'Runtime.evaluate')
      .map((c) => `${c.method}:${String(c.params?.type ?? c.params?.enabled ?? c.params?.ms)}`)
    expect(seq).toEqual([
      'Input.setInterceptDrags:true',
      'Input.dispatchMouseEvent:mousePressed',
      'wait:Input.dragIntercepted:5000',
      'Input.dispatchMouseEvent:mouseMoved',
      'Input.dispatchMouseEvent:mouseReleased',
      'wait:Input.dragIntercepted:5000',
      'Input.dispatchDragEvent:dragEnter',
      'Input.dispatchDragEvent:dragOver',
      'Input.dispatchDragEvent:drop',
      'Input.setInterceptDrags:false'
    ])
    expect(f.r.cdp.calls.find((c) => c.params?.type === 'drop')?.params).toMatchObject({ x: 300, y: 400, data: f.data })
  })

  it('on a desk with its own pointer, gives a move that reaches the page late its own wait before dragging with the pointer', async () => {
    // CI run 37986116530: on Xvfb the CDP move reached the page 2.4 s after the press, past a wait timed
    // from before the move, so the drag it started was dropped and the pointer's press found none.
    const r = rig()
    const presses: unknown[] = []
    r.desk.pointer = { press: async (a) => void presses.push(a), release: async () => {} }
    await r.h.launch({ command: 'app' })
    r.cdp.evaluates({ x: 10, y: 20 }, { x: 300, y: 400 })
    const data = { items: [{ mimeType: 'text/plain', data: 'card-1' }], dragOperationsMask: 1 }
    let reach: () => void = () => {}
    const reached = new Promise<void>((res) => (reach = res))
    const send = r.cdp.send.bind(r.cdp)
    r.cdp.send = async (method, params) => {
      const out = await send(method, params)
      if (params?.type === 'mouseMoved') await reached
      return out
    }
    r.cdp.waitEvent = (_method, ms) =>
      new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('timed out')), ms)
        void reached.then(() => (clearTimeout(t), res({ data })))
      })
    vi.useFakeTimers()
    try {
      const done = r.h.drag('#card', '#column')
      await vi.advanceTimersByTimeAsync(DRAG_CDP_MS + 400)
      reach()
      await vi.advanceTimersByTimeAsync(0)
      await done
    } finally {
      vi.useRealTimers()
    }
    expect(presses).toEqual([])
    expect(r.cdp.calls.find((c) => c.params?.type === 'drop')?.params).toMatchObject({ x: 300, y: 400, data })
  })

  it('names a source neither press starts a drag from, and still lets the real button go', async () => {
    const f = fallbackRig(false)
    await f.r.h.launch({ command: 'app' })
    f.r.cdp.evaluates({ x: 1, y: 1 }, { x: 2, y: 2 }, { title: '', offX: 0, offY: 0, dpr: 1 })
    await expect(f.r.h.drag('#plain', '#column')).rejects.toThrow('drag: #plain did not start a drag (is it draggable?)')
    expect(f.presses).toEqual([{ title: '', from: { x: 1, y: 1 }, to: { x: 2, y: 2 } }])
    expect(f.releases()).toBe(1)
    expect(f.r.cdp.calls.at(-1)).toMatchObject({ method: 'Input.setInterceptDrags', params: { enabled: false } })
  })

  it('turns viewport points into window device pixels: the frame and menu bar before the viewport, times the pixel ratio', () => {
    expect(windowPoint({ title: '', offX: 0, offY: 28, dpr: 1 }, { x: 48, y: 70 })).toEqual({ x: 48, y: 98 })
    expect(windowPoint({ title: '', offX: 4, offY: 30, dpr: 1.5 }, { x: 10.2, y: 20.4 })).toEqual({ x: 21, y: 76 })
    // A page that reports nonsense is taken as a plain viewport at ratio 1.
    expect(windowPoint({ title: '', offX: -8, offY: -8, dpr: 0 }, { x: 5, y: 6 })).toEqual({ x: 5, y: 6 })
  })

  it('reads an element again while its centre is outside the viewport, then uses the reading inside it', async () => {
    const r = rig()
    await r.h.launch({ command: 'app' })
    r.cdp.evaluates({ x: -60, y: -116, vw: 0, vh: 0 }, { x: 5, y: 6, vw: 900, vh: 673 })
    await r.h.dropFiles('#drop', [process.platform === 'win32' ? 'C:\\a.txt' : '/a.txt'])
    // One more for launch's wait for the page.
    expect(r.cdp.calls.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(1 + 2)
    expect(r.cdp.calls.find((c) => c.params?.type === 'drop')?.params).toMatchObject({ x: 5, y: 6 })
  })

  it('fails with the numbers, pressing nothing, when the centre never comes inside the viewport (CI run 36312079513)', async () => {
    vi.useFakeTimers()
    try {
      const r = rig()
      await r.h.launch({ command: 'app' })
      r.cdp.answers.set('Runtime.evaluate', () => ({ result: { value: { x: -60, y: -116, vw: 0, vh: 0 } } }))
      const drag = r.h.drag('#src', '#dst').then(
        () => null,
        (e: Error) => e.message
      )
      await vi.advanceTimersByTimeAsync(LAYOUT_TRIES * 100 + 1_000)
      expect(await drag).toBe(
        "drag: #src is outside the page's viewport even after scrolling it into view (its centre is at -60,-116; the viewport is 0x0)"
      )
      expect(r.cdp.calls.filter((c) => c.method === 'Runtime.evaluate')).toHaveLength(1 + LAYOUT_TRIES)
      expect(r.cdp.calls.some((c) => c.method === 'Input.dispatchMouseEvent')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('knows a centre inside the viewport from one outside it', () => {
    expect(insideViewport({ x: 48, y: 70, vw: 900, vh: 673 })).toBe(true)
    expect(insideViewport({ x: -60, y: -116, vw: 900, vh: 673 })).toBe(false)
    expect(insideViewport({ x: 0, y: 0, vw: 0, vh: 0 })).toBe(false)
    expect(insideViewport({ x: 900, y: 10, vw: 900, vh: 673 })).toBe(false)
    expect(insideViewport({ x: 1, y: 2 })).toBe(true)
  })

  it('a selector that matches nothing is named', async () => {
    const r = rig()
    await r.h.launch({ command: 'app.exe' })
    r.cdp.evaluates(null)
    await expect(r.h.drag('#none', '#column')).rejects.toThrow('drag: nothing matches #none')
  })

  it('dropFiles drops absolute paths on the element', async () => {
    const r = rig()
    await r.h.launch({ command: 'app.exe' })
    await expect(r.h.dropFiles('#drop', ['relative.txt'])).rejects.toThrow('absolute file paths')
    await expect(r.h.dropFiles('#drop', [])).rejects.toThrow('absolute file paths')
    r.cdp.evaluates({ x: 5, y: 6 })
    const file = process.platform === 'win32' ? 'C:\\data\\a b.txt' : '/data/a b.txt'
    await r.h.dropFiles('#drop', [file])
    const drops = r.cdp.calls.filter((c) => c.method === 'Input.dispatchDragEvent')
    expect(drops.map((c) => c.params?.type)).toEqual(['dragEnter', 'dragOver', 'drop'])
    expect(drops[2].params).toMatchObject({ x: 5, y: 6, data: { items: [], files: [file], dragOperationsMask: 1 } })
  })
})

describe('captures and native windows', () => {
  it('screenshot saves the page as PNG and reads its size off the header', async () => {
    const r = rig()
    await r.h.launch({ command: 'app.exe' })
    r.cdp.answers.set('Page.captureScreenshot', () => ({ data: png(1280, 720) }))
    expect(await r.h.screenshot()).toEqual({ path: 'C:/shots/app-1.png', width: 1280, height: 720 })
    expect(r.deps.saveCapture).toHaveBeenCalledWith(png(1280, 720), 'png')
    expect(pngSize('bm90IGEgcG5n')).toEqual({ width: 0, height: 0 })
  })

  it('windowShot photographs a native window by title', async () => {
    const r = rig()
    await r.h.launch({ command: 'app.exe' })
    expect(await r.h.windowShot('Save As')).toEqual({ path: 'C:/shots/app-1.png', width: 800, height: 600, title: 'Fixture' })
    expect(r.desk.shotCalls[0]).toEqual({ title: 'Save As', format: 'png' })
    await r.h.windowShot()
    expect(r.desk.shotCalls[1]).toEqual({ format: 'png' })
  })

  it('keys posts a named key or text to a window', async () => {
    const r = rig()
    await r.h.launch({ command: 'app.exe' })
    await r.h.keys('Save As', 'Enter')
    await r.h.keys('Save As', 'report 1.txt')
    expect(r.desk.keyCalls).toEqual([
      { title: 'Save As', key: 'Enter' },
      { title: 'Save As', text: 'report 1.txt' }
    ])
    await expect(r.h.keys('', 'x')).rejects.toThrow('window title')
  })
})

describe('help', () => {
  it('prints the guide, or one section of it', async () => {
    const r = rig()
    const help = r.h.help as unknown as (n?: string) => string
    expect(help()).toContain('# guide')
    expect(help('windows')).toBe('## windows()\nLists them.')
    expect(help('nope')).toContain('no helper named nope')
  })
})

describe('launchEnv', () => {
  it('collapses names that differ only in case on Windows, and not elsewhere', () => {
    expect(launchEnv({ Path: 'C:\\a', HOME: 'h' }, { PATH: 'C:\\b' }, 'win32')).toEqual({ HOME: 'h', PATH: 'C:\\b' })
    expect(launchEnv({ Path: 'a' }, { PATH: 'b' }, 'linux')).toEqual({ Path: 'a', PATH: 'b' })
    expect(launchEnv({ A: undefined, B: '1' }, {}, 'win32')).toEqual({ B: '1' })
  })
})

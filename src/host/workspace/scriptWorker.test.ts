// The Host's `app js` runner: the script runs in a worker thread the Host can terminate, and the
// helpers stay on this thread. The busy loops below are bounded (they end on their own after LOOP_MS)
// so that a runner which does run them on this thread fails these tests instead of hanging them.
//
// Nothing here times the worker's start: CI runners are shared and a worker can take long to start.
// Each loop test has the script call `mark()`, not awaited, right before its loop, and counts this
// thread's ticks from that call. Ticks while the loop runs prove this thread was not blocked; the
// outcome (cut off, never `log('never')`) proves the loop was ended rather than finished. The only
// time bound left is many seconds below the loop's own end.
import { afterAll, describe, it, expect, vi } from 'vitest'
import { Interrupted } from '../../core/agentBrowser/script'
import { workspaceHelpers, type HelperDeps } from '../../core/workspace/helpers'
import { endChild, runScriptInWorker, scriptChildEnv } from './scriptWorker'
import type { ScriptClock } from '../../core/workspace/script'

// Records every child process the runner spawns, delegating to the real spawn, so a test can say none
// was started, reach one to kill it from outside, and check at the end that none is left running.
const made = vi.hoisted(() => ({ children: [] as import('node:child_process').ChildProcess[], dropMemoryReport: false }))
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const spawn = ((...a: Parameters<typeof real.spawn>) => {
    const c = (real.spawn as (...b: unknown[]) => import('node:child_process').ChildProcess)(...a)
    made.children.push(c)
    // Simulates the Host reading the exit before the report: the child's memory message never arrives.
    if (made.dropMemoryReport) {
      const emit = c.emit.bind(c)
      c.emit = ((ev: string, ...rest: unknown[]) => (ev === 'message' && (rest[0] as { type?: string })?.type === 'memory' ? false : emit(ev, ...rest))) as typeof c.emit
    }
    return c
  }) as typeof real.spawn
  return { ...real, spawn, default: { ...real, spawn } }
})

const gone = (c: import('node:child_process').ChildProcess): boolean => {
  if (c.exitCode !== null || c.signalCode !== null) return true
  try {
    process.kill(c.pid!, 0)
    return false
  } catch {
    return true
  }
}

// Every path ends its child: whatever a test did, nothing it spawned is still running after it.
afterAll(async () => {
  await vi.waitFor(() => expect(made.children.filter((c) => !gone(c)).map((c) => c.pid)).toEqual([]), { timeout: 15_000, interval: 100 })
}, 20_000)

const LOOP_MS = 20_000
const LOOP_TEST_MS = 40_000
const TIMEOUT_MS = 3_000
const busy = `mark(); { const end = Date.now() + ${LOOP_MS}; while (Date.now() < end) {} }`
const GUIDE = '# guide\n\nIntro.\n\n## windows()\nLists them.\n\n## launch(spec)\nStarts it.\n\n## windows(again)\nNot this one.\n'

type Helpers = Record<string, unknown>
type Over = { stop?: AbortSignal; timeoutMs?: number; onHelper?: (n: string | null) => void; memoryCapMb?: number; heapLimitMb?: number }
const run = (script: string, helpers: Helpers = {}, over: Over = {}) =>
  runScriptInWorker({
    script,
    guide: GUIDE,
    stop: over.stop ?? new AbortController().signal,
    onHelper: over.onHelper ?? (() => {}),
    timeoutMs: over.timeoutMs,
    memoryCapMb: over.memoryCapMb,
    heapLimitMb: over.heapLimitMb,
    helpers: () => helpers
  })

/** Runs a loop script with `mark` and `nop` helpers, and counts this thread's ticks from the moment
 *  the script called `mark()`: a blocked thread counts none. */
function loopRun(script: string, over: { stop?: AbortSignal; timeoutMs?: number } = {}) {
  let ticks = 0
  let markedAt: { ticks: number; ms: number } | null = null
  const iv = setInterval(() => (ticks += 1), 20)
  const result = run(script, { nop: async () => {}, mark: async () => void (markedAt = { ticks, ms: Date.now() }) }, over).then((value) => {
    clearInterval(iv)
    if (!markedAt) throw new Error('the script never reached its loop')
    return { value, ticksInLoop: ticks - markedAt.ticks, msInLoop: Date.now() - markedAt.ms }
  })
  return { result, marked: () => markedAt !== null, ticksSinceMark: () => (markedAt ? ticks - markedAt.ticks : 0) }
}

describe('a busy loop is cut off', () => {
  it('after an await, at the deadline, and this thread keeps running meanwhile', { timeout: LOOP_TEST_MS }, async () => {
    const r = await loopRun(`await nop(); ${busy}; log('never')`, { timeoutMs: TIMEOUT_MS }).result
    expect(r.value.log).toEqual([])
    expect(r.value.error?.at).toBe('timeout')
    expect(r.value.error?.message).toMatch(new RegExp(`^script did not finish within ${TIMEOUT_MS} ms`))
    expect(r.ticksInLoop).toBeGreaterThanOrEqual(3)
    expect(r.msInLoop).toBeLessThan(LOOP_MS - 10_000)
  })

  it('before any await, with the "never awaited" wording', { timeout: LOOP_TEST_MS }, async () => {
    const r = await loopRun(`log('first'); ${busy}; await nop()`, { timeoutMs: TIMEOUT_MS }).result
    expect(r.value).toEqual({ log: ['first'], error: { at: 'timeout', message: `script did not finish within ${TIMEOUT_MS} ms (it never awaited)` } })
    expect(r.ticksInLoop).toBeGreaterThanOrEqual(3)
    expect(r.msInLoop).toBeLessThan(LOOP_MS - 10_000)
  })

  it('by Stop, at "stopped"', { timeout: LOOP_TEST_MS }, async () => {
    const stop = new AbortController()
    const r = loopRun(`await nop(); ${busy}; log('never')`, { stop: stop.signal })
    await vi.waitFor(() => expect(r.ticksSinceMark()).toBeGreaterThanOrEqual(3), { timeout: LOOP_MS - 10_000, interval: 20 })
    stop.abort()
    const done = await r.result
    expect(done.value).toEqual({ log: [], error: { message: 'stopped', at: 'stopped' } })
    expect(done.msInLoop).toBeLessThan(LOOP_MS - 10_000)
  })

  it('a Stop already given returns at once, without starting a child', async () => {
    const stop = new AbortController()
    stop.abort()
    const called = vi.fn()
    const before = made.children.length
    const r = await run('await nop()', { nop: async () => called() }, { stop: stop.signal })
    expect(r).toEqual({ log: [], error: { message: 'stopped', at: 'stopped' } })
    expect(called).not.toHaveBeenCalled()
    expect(made.children.length).toBe(before)
    await run("log('x')")
    expect(made.children.length).toBe(before + 1)
  })
})

describe('helpers cross to this thread', () => {
  it('passes arguments and results, and reports each helper while it runs', async () => {
    const seen: Array<string | null> = []
    const r = await runScriptInWorker({
      script: "log(await add(1, 2)); log(await echo({ a: [1, 'x'], b: null })); log('end')",
      guide: GUIDE,
      stop: new AbortController().signal,
      onHelper: (n) => seen.push(n),
      helpers: (ctx) => ({
        add: async (x: number, y: number) => {
          ctx.at = 'add'
          return x + y
        },
        echo: async (v: unknown) => {
          ctx.at = 'echo'
          return v
        }
      })
    })
    expect(r).toEqual({ log: ['3', '{"a":[1,"x"],"b":null}', 'end'] })
    expect(seen).toEqual(['add', null, 'echo', null])
  })

  it('keeps log order around helper calls, and log stringifies in the script', async () => {
    const r = await run("log('a'); log(await v()); log(undefined); log({ f() {} }); const c = {}; c.c = c; log(c); log('z')", { v: async () => 'b' })
    expect(r).toEqual({ log: ['a', 'b', 'undefined', '{}', '[object Object]', 'z'] })
  })

  it('a helper error names the helper, and an Interrupted keeps its own at', async () => {
    const plain = await runScriptInWorker({
      script: "log('before'); await launch({})",
      guide: GUIDE,
      stop: new AbortController().signal,
      onHelper: () => {},
      helpers: (ctx) => ({
        launch: async () => {
          ctx.at = 'launch'
          throw new Error('launch: bad')
        }
      })
    })
    expect(plain).toEqual({ log: ['before'], error: { message: 'launch: bad', at: 'launch' } })

    const timed = await run('await waitFor(1)', { waitFor: async () => { throw new Interrupted('waitFor', 'waitFor did not finish within 30000 ms') } })
    expect(timed.error).toEqual({ message: 'waitFor did not finish within 30000 ms', at: 'waitFor' })
  })

  it('the script can catch a helper error and read its message', async () => {
    const r = await run("try { await bad() } catch (e) { log(e.message) } log('after')", { bad: async () => { throw new Error('nope') } })
    expect(r).toEqual({ log: ['nope', 'after'] })
  })

  it('a helper error that cannot be read still settles the call, with a fallback message', async () => {
    const unreadable = Object.create(null) as object
    const r = await runScriptInWorker({
      script: "try { await bad() } catch (e) { log(e.message) } log('after'); await bad()",
      guide: GUIDE,
      stop: new AbortController().signal,
      onHelper: () => {},
      timeoutMs: 5_000,
      helpers: (ctx) => ({
        bad: () => {
          ctx.at = 'bad'
          return Promise.reject(unreadable)
        }
      })
    })
    expect(r).toEqual({ log: ['bad: the helper failed with an error that cannot be read', 'after'], error: { message: 'bad: the helper failed with an error that cannot be read', at: 'bad' } })
  })

  it('an error the script throws itself is at "script", and so is a syntax error', async () => {
    expect((await run("throw new Error('mine')")).error).toEqual({ message: 'mine', at: 'script' })
    expect((await run("throw 'text'")).error).toEqual({ message: 'text', at: 'script' })
    expect((await run('await nop(); throw new Error("later")', { nop: async () => {} })).error).toEqual({ message: 'later', at: 'script' })
    const syntax = await run('this is not javascript')
    expect(syntax.error?.at).toBe('script')
    expect(syntax.error?.message).toMatch(/Unexpected/)
  })

  it('an argument that does not clone is converted rather than failing the call', async () => {
    const got: unknown[] = []
    const r = await run('await take(() => 1, { keep: 1, drop() {} }, Symbol("s")); log("ok")', {
      take: async (...a: unknown[]) => {
        got.push(...a)
      }
    })
    expect(r).toEqual({ log: ['ok'] })
    expect(got).toEqual(['() => 1', { keep: 1 }, 'Symbol(s)'])
  })

  it('a result that does not clone becomes the helper error', async () => {
    const r = await run('await give()', { give: async () => () => 1 })
    expect(r.error?.at).toBe('give')
    expect(r.error?.message).toMatch(/^give: its result could not be handed to the script/)
  })

  it('an un-awaited helper that rejects does not end the script', async () => {
    const r = await run("bad(); await nop(); log('after')", { bad: async () => { throw new Error('x') }, nop: async () => {} })
    expect(r).toEqual({ log: ['after'] })
  })

  it('a helper still pending when the worker is ended settles without an unhandled rejection', { timeout: 20_000 }, async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      // Ended by Stop once the helper is known to be pending, not by a short deadline: the deadline
      // counts from the child's spawn, and on a loaded machine the child had not reached `slow()` by
      // then, so the helper was never called. Stop and the deadline end the worker through the same
      // path (finish), so what is left pending is the same. The 15s wait (and the 20s budget of this
      // test and the next) is for that child's start alone, the same allowance the launch tests give it.
      let fail!: (e: Error) => void
      const stop = new AbortController()
      const p = run('await slow()', { slow: () => new Promise((_, reject) => (fail = reject)) }, { stop: stop.signal })
      await vi.waitFor(() => expect(fail).toBeTypeOf('function'), { timeout: 15_000, interval: 20 })
      stop.abort()
      expect((await p).error?.at).toBe('stopped')
      fail(new Error('late'))
      await new Promise((res) => setTimeout(res, 50))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('a helper the body calls after the script ended is never run', { timeout: 20_000 }, async () => {
    const after = vi.fn()
    let release!: () => void
    const stop = new AbortController()
    const p = run('await wait(); await next()', { wait: () => new Promise<void>((r) => (release = r)), next: async () => after() }, { stop: stop.signal })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'), { timeout: 15_000, interval: 20 })
    stop.abort()
    expect((await p).error).toEqual({ message: 'stopped', at: 'stopped' })
    release()
    await new Promise((r) => setTimeout(r, 50))
    expect(after).not.toHaveBeenCalled()
  })
})

// Stage 4, task 2: the time a launch spends waiting for the app's port and page is not the script's.
// Scaled down: a 3 s deadline (long enough for a child to start on a shared CI runner) and a launch
// wait longer than it. The wait is marked the way the real launch helper marks it, through the clock
// the runner hands the helpers.
describe('launch waits do not count against the deadline', () => {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  const withLaunch = (script: string, launch: (clock: ScriptClock) => Promise<unknown>, over: { stop?: AbortSignal } = {}) =>
    runScriptInWorker({
      script,
      guide: GUIDE,
      stop: over.stop ?? new AbortController().signal,
      onHelper: () => {},
      timeoutMs: TIMEOUT_MS,
      helpers: (_ctx, clock) => ({ launch: () => launch(clock), nop: async () => {} })
    })

  it('a launch that waits longer than the whole deadline succeeds, and the script goes on after it', { timeout: LOOP_TEST_MS }, async () => {
    const r = await withLaunch("log(await launch()); log('after')", async (clock) => {
      const w = clock.launchWait()
      try {
        await sleep(TIMEOUT_MS + 1_500)
        return 'up'
      } finally {
        w.end()
      }
    })
    expect(r).toEqual({ log: ['up', 'after'] })
  })

  it('a busy loop after the launch is still cut, at the deadline counted without the wait', { timeout: LOOP_TEST_MS }, async () => {
    let endedAt = 0
    const r = await withLaunch(`await launch(); log('launched'); { const end = Date.now() + ${LOOP_MS}; while (Date.now() < end) {} } log('never')`, async (clock) => {
      const w = clock.launchWait()
      await sleep(TIMEOUT_MS + 1_500)
      w.end()
      endedAt = Date.now()
    })
    expect(r.log).toEqual(['launched'])
    expect(r.error?.at).toBe('timeout')
    expect(r.error?.message).toMatch(new RegExp(`^script did not finish within ${TIMEOUT_MS} ms`))
    expect(Date.now() - endedAt).toBeLessThan(LOOP_MS - 10_000)
  })

  it('Stop during a long launch wait ends the script at once, past where the deadline would have been', { timeout: LOOP_TEST_MS }, async () => {
    const stop = new AbortController()
    let waitingSince = 0
    const r = withLaunch('await launch()', (clock) => {
      clock.launchWait()
      waitingSince = Date.now()
      return new Promise<never>(() => {})
    }, { stop: stop.signal })
    let settled = false
    void r.then(() => (settled = true))
    await vi.waitFor(() => expect(waitingSince).toBeGreaterThan(0), { timeout: 15_000, interval: 20 })
    await sleep(TIMEOUT_MS + 500)
    expect(settled).toBe(false)
    const t0 = Date.now()
    stop.abort()
    expect(await r).toEqual({ log: [], error: { message: 'stopped', at: 'stopped' } })
    expect(Date.now() - t0).toBeLessThan(1_000)
  })
})

describe('help', () => {
  it('answers in the worker, without await, exactly as the helper on this thread does', async () => {
    const own = workspaceHelpers({ guide: GUIDE } as HelperDeps, { at: 'script' }).help as (n?: unknown) => string
    const names = ['windows', 'launch', 'nope', 'constructor', '__proto__', 'Intro.']
    const r = await run(`log(help()); ${names.map((n) => `log(help(${JSON.stringify(n)}))`).join('; ')}; log(help(42))`)
    expect(r).toEqual({ log: [own(), ...names.map((n) => own(n)), own(42)] })
  })
})

// The script runs in a child process of its own, so memory it takes is the child's. The caps here are
// lowered for the test (the defaults are 512 MB of rss and 256 MB of heap), and every script is bounded
// well below a gigabyte, so a runner that kept the script in this process fails these tests without
// endangering the run.
describe('memory and crashes end only the child', () => {
  /** This process's largest rss growth while `work` runs, sampled every 20 ms. */
  async function peakGrowth<T>(work: () => Promise<T>): Promise<{ value: T; growthMb: number }> {
    const base = process.memoryUsage.rss()
    let peak = base
    const iv = setInterval(() => (peak = Math.max(peak, process.memoryUsage.rss())), 20)
    try {
      const value = await work()
      return { value, growthMb: (Math.max(peak, process.memoryUsage.rss()) - base) / (1024 * 1024) }
    } finally {
      clearInterval(iv)
    }
  }

  it('filling large ArrayBuffers ends at "memory", and this process never holds them', { timeout: 40_000 }, async () => {
    const script =
      'const keep = []; for (let i = 0; i < 40; i++) { const b = new ArrayBuffer(16 * 1024 * 1024); new Uint8Array(b).fill(1); keep.push(b); ' +
      "const t = Date.now() + 25; while (Date.now() < t) {} } log('survived')"
    const r = await peakGrowth(() => run(script, {}, { memoryCapMb: 160, timeoutMs: 20_000 }))
    expect(r.value).toEqual({ log: [], error: { at: 'memory', message: 'the script used more than 160 MB of memory and was ended' } })
    expect(r.growthMb).toBeLessThan(150)
    expect(await run("log('alive')")).toEqual({ log: ['alive'] })
  })

  it('a child that ends itself for memory is "memory" even when its report is never read', { timeout: 40_000 }, async () => {
    const script =
      'const keep = []; for (let i = 0; i < 40; i++) { const b = new ArrayBuffer(16 * 1024 * 1024); new Uint8Array(b).fill(1); keep.push(b); ' +
      "const t = Date.now() + 25; while (Date.now() < t) {} } log('survived')"
    made.dropMemoryReport = true
    try {
      const r = await run(script, {}, { memoryCapMb: 160, timeoutMs: 20_000 })
      expect(r).toEqual({ log: [], error: { at: 'memory', message: 'the script used more than 160 MB of memory and was ended' } })
    } finally {
      made.dropMemoryReport = false
    }
  })

  it('a heap that keeps growing hits the worker heap limit and ends at "memory"', { timeout: 40_000 }, async () => {
    const script = "const keep = []; for (let i = 0; i < 3e6; i++) keep.push({ i, s: 'x' + i, a: [i, i, i] }); log('survived')"
    const r = await run(script, {}, { heapLimitMb: 32, timeoutMs: 20_000 })
    expect(r).toEqual({ log: [], error: { at: 'memory', message: 'the script ran out of memory (its heap is limited to 32 MB)' } })
  })

  it('an allocation that makes V8 end the whole child is read as "memory" too', { timeout: 40_000 }, async () => {
    const r = await run("const a = new Array(3e7).fill(0.5); log('survived')", {}, { heapLimitMb: 32, timeoutMs: 20_000 })
    expect(r.log).toEqual([])
    expect(r.error?.at).toBe('memory')
    expect(r.error?.message).toMatch(/^the script ran out of memory/)
  })

  it('a child killed from outside mid-call ends at "crashed", and its pending helper settles without an unhandled rejection', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      let fail: ((e: Error) => void) | undefined
      const before = made.children.length
      const p = run("await slow(); log('never')", { slow: () => new Promise((_, reject) => (fail = reject)) })
      await vi.waitFor(() => expect(fail).toBeTypeOf('function'))
      made.children[before].kill('SIGKILL')
      const r = await p
      expect(r).toEqual({ log: [], error: { at: 'crashed', message: expect.stringMatching(/^the script's process ended unexpectedly/) } })
      fail!(new Error('late'))
      await new Promise((res) => setTimeout(res, 50))
      expect(unhandled).not.toHaveBeenCalled()
      expect(await run("log('alive')")).toEqual({ log: ['alive'] })
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})

describe('the child environment', () => {
  it('is built from a short list, so no session, agent or node setting reaches it', () => {
    const env = scriptChildEnv({
      SystemRoot: 'C:/Windows',
      TEMP: 't',
      ASTERA_SESSION_ID: 'x',
      ASTERA_HOST_LOG: 'l',
      CLAUDE_CODE_SESSION_ID: 'c',
      CODEX_HOME: 'h',
      NODE_OPTIONS: '--require evil',
      PATH: 'p',
      ELECTRON_RUN_AS_NODE: '0'
    })
    expect(env).toEqual({ ELECTRON_RUN_AS_NODE: '1', SystemRoot: 'C:/Windows', TEMP: 't' })
  })

  it('is what the script process sees', async () => {
    const keys = ['ASTERA_LEAK_TEST', 'CLAUDE_LEAK_TEST', 'CODEX_LEAK_TEST']
    for (const k of keys) process.env[k] = '1'
    try {
      // The vm is not a boundary (scriptWorker.ts): a helper's constructor reaches the worker's process.
      const r = await run("const p = log.constructor('return process')(); log(Object.keys(p.env).filter((k) => /^(ASTERA|CLAUDE|CODEX)_/i.test(k)).join(','))")
      expect(r).toEqual({ log: [''] })
    } finally {
      for (const k of keys) delete process.env[k]
    }
  })
})

describe('ending the child', () => {
  const deadChild = () => ({ pid: 4242, exitCode: 1, signalCode: null, kill: vi.fn() }) as unknown as import('node:child_process').ChildProcess

  it('off win32, kills the process group even when the child itself has already exited', () => {
    const kill = vi.fn(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    })
    const c = deadChild()
    expect(() => endChild(c, 'linux', kill)).not.toThrow()
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL')
    expect(c.kill).not.toHaveBeenCalled()
  })

  it('on win32, leaves a child that has already exited alone', () => {
    const kill = vi.fn()
    const c = deadChild()
    endChild(c, 'win32', kill)
    expect(kill).not.toHaveBeenCalled()
    expect(c.kill).not.toHaveBeenCalled()
  })
})

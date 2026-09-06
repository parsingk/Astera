import { describe, it, expect } from 'vitest'
import { runScript } from './scriptRunner'
import { createLog } from './script'

const run = (script: string, helpers: Record<string, unknown> = {}, opts?: { timeoutMs?: number; signal?: AbortSignal }) => {
  const log = createLog()
  const ctx = { at: 'script' }
  return runScript(script, helpers, log, ctx, opts)
}

describe('runScript', () => {
  it('sees only the helpers and log', async () => {
    const r = await run(`log(typeof require); log(typeof process); log(typeof fetch); log(typeof setTimeout); log(typeof console)`)
    expect(r.error).toBeUndefined()
    expect(r.log).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined'])
  })

  it('awaits helpers and logs their results in order', async () => {
    const r = await run(`const a = await twice(2); log(a); log(await twice(a))`, { twice: async (n: number) => n * 2 })
    expect(r).toEqual({ log: ['4', '8'] })
  })

  it('keeps the log written before a throw, and names the helper that was running', async () => {
    const ctx = { at: 'script' }
    const log = createLog()
    const helpers = {
      click: async (sel: string) => {
        ctx.at = 'click'
        throw new Error(`nothing matches ${sel}`)
      }
    }
    const r = await runScript(`log('before'); await click('#x'); log('after')`, helpers, log, ctx)
    expect(r.log).toEqual(['before'])
    expect(r.error).toEqual({ message: 'nothing matches #x', at: 'click' })
  })

  it('a throw between helpers is at "script"', async () => {
    const r = await run(`log(1); throw new Error('mine')`)
    expect(r.error).toEqual({ message: 'mine', at: 'script' })
    expect(r.log).toEqual(['1'])
  })

  it('a syntax error is reported, not thrown out of the runner', async () => {
    const r = await run(`this is not javascript`)
    expect(r.error?.at).toBe('script')
    expect(r.error?.message).toMatch(/Unexpected/)
  })

  it('the whole-script deadline ends it with at: timeout and the log kept', async () => {
    const r = await run(`log('started'); await new Promise(() => {})`, {}, { timeoutMs: 30 })
    expect(r.log).toEqual(['started'])
    expect(r.error).toEqual({ message: 'script did not finish within 30 ms', at: 'timeout' })
  })

  // The other half of that deadline: a body with no `await` in it never returns to the event loop, so
  // neither the timer nor the abort above can ever reach it — only `runInContext`'s own `timeout` can.
  // It is the same whole-script deadline, so it is reported the same way rather than as a host error
  // at 'script'.
  it('a body that never awaits is cut off by the same deadline, and reported at: timeout', async () => {
    const r = await run(`log('started'); while (true) {}`, {}, { timeoutMs: 30 })
    expect(r.log).toEqual(['started'])
    expect(r.error).toEqual({ message: 'script did not finish within 30 ms (it never awaited)', at: 'timeout' })
  })

  it('the injected log stops recording once the run is over', async () => {
    const ac = new AbortController()
    const ctx = { at: 'script' }
    const log = createLog()
    let resume!: () => void
    const helpers = { wait: () => new Promise<void>((r) => (resume = r)) }
    const p = runScript(`log('before'); await wait(); log('after')`, helpers, log, ctx, { signal: ac.signal })
    ac.abort()
    const r = await p
    expect(r.log).toEqual(['before'])
    // The abandoned body runs on — it resumes and logs — but the sink the caller still holds is done.
    resume()
    await new Promise((r) => setTimeout(r, 0))
    expect(log.lines).toEqual(['before'])
  })

  it('an aborted signal ends it at the running helper with "stopped"', async () => {
    const ac = new AbortController()
    const ctx = { at: 'script' }
    const log = createLog()
    const helpers = {
      waitForever: () => {
        ctx.at = 'waitForever'
        return new Promise(() => {})
      }
    }
    const p = runScript(`await waitForever()`, helpers, log, ctx, { signal: ac.signal })
    setTimeout(() => ac.abort(), 10)
    const r = await p
    expect(r.error).toEqual({ message: 'stopped', at: 'waitForever' })
  })

  it('a script that returns a value logs nothing extra', async () => {
    const r = await run(`return 5`)
    expect(r).toEqual({ log: [] })
  })

  // Not a statement that the sandbox holds: it does not. The helpers are host functions, so
  // `help.constructor('return process')()` does hand a script the host `process` — scriptRunner.ts's
  // header says so and says why that is accepted. What this pins is the narrower thing that is true:
  // `Error` inside the context is the context's own realm, so the `Function` reached through it
  // compiles its body in the sandbox, where `process` is not defined.
  it("Error inside the context belongs to the context's own realm", async () => {
    const r = await run(`const F = Error.constructor; const proc = F("return process")()`)
    expect(r.error?.at).toBe('script')
    expect(r.error?.message).toMatch(/process is not defined/)
  })

  it('returns a copy of the log, not the sink an abandoned script keeps writing to', async () => {
    const log = createLog()
    const r = await runScript(`log('a')`, {}, log, { at: 'script' })
    expect(r.log).toEqual(['a'])
    expect(r.log).not.toBe(log.lines)
    log.log('written after the run returned')
    expect(r.log).toEqual(['a'])
  })

  it('still reports a script-thrown error by its message, across the realm boundary', async () => {
    const r = await run(`throw new Error('mine')`)
    expect(r.error).toEqual({ message: 'mine', at: 'script' })
  })
})

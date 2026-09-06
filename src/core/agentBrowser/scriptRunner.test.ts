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

  it('hands the script no host object to climb out through', async () => {
    const r = await run(`const F = Error.constructor; const proc = F("return process")()`)
    // Even though Error.constructor exists, it cannot create code that escapes the sandbox
    expect(r.error?.at).toBe('script')
    expect(r.error?.message).toMatch(/process is not defined/)
  })

  it('still reports a script-thrown error by its message, across the realm boundary', async () => {
    const r = await run(`throw new Error('mine')`)
    expect(r.error).toEqual({ message: 'mine', at: 'script' })
  })
})

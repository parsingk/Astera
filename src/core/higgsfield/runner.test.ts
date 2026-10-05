import { describe, it, expect } from 'vitest'
import { binaryMissingIn, realRunner } from './runner'

describe('binaryMissingIn', () => {
  it('reads the path from the npm launcher\'s "binary not found" line', () => {
    const stderr = '@higgsfield/cli: binary not found at C:\\Program Files\\nodejs\\node_modules\\@higgsfield\\cli\\vendor\\hf.exe. Reinstall: npm i -g @higgsfield/cli\n'
    expect(binaryMissingIn({ code: 1, stdout: '', stderr }))
      .toBe('C:\\Program Files\\nodejs\\node_modules\\@higgsfield\\cli\\vendor\\hf.exe')
    expect(binaryMissingIn({ code: 1, stdout: '', stderr: '@higgsfield/cli: binary not found at /usr/lib/node_modules/@higgsfield/cli/vendor/hf\n' }))
      .toBe('/usr/lib/node_modules/@higgsfield/cli/vendor/hf')
  })
  it('is null for a run that succeeded or failed for another reason', () => {
    expect(binaryMissingIn({ code: 0, stdout: 'binary not found at x', stderr: '' })).toBeNull()
    expect(binaryMissingIn({ code: 2, stdout: '', stderr: 'Error: Session expired.\nHint: Run: hf auth login' })).toBeNull()
  })
})

describe('realRunner signal', () => {
  // node itself (the test runner's executable, by absolute path) stands in for a login waiting forever.
  const waitForever = ['-e', 'process.stdout.write("waiting\\n"); setInterval(() => {}, 1000)']
  it('kills the child it started when the signal aborts, and answers once it exited', async () => {
    const ctl = new AbortController()
    let out = ''
    const run = realRunner(process.execPath, process.platform, waitForever, { stdin: 'ignore', signal: ctl.signal, onStdout: (c) => { out += c } })
    const p = run([], process.env, false)
    while (!out.includes('waiting')) await new Promise((r) => setTimeout(r, 10))
    const t0 = Date.now()
    ctl.abort()
    const r = await p
    expect(r.code).not.toBe(0)
    expect(Date.now() - t0).toBeLessThan(5000)
  }, 15000)
  it('answers anyway when the child never exits after the kill', async () => {
    const { EventEmitter } = await import('node:events')
    let kills = 0
    const fakeSpawn = (() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(),
        kill: () => { kills++; return true }      // ignores it: no 'exit', no 'close'
      })
      return child
    }) as unknown as typeof import('node:child_process').spawn
    const ctl = new AbortController()
    const p = realRunner('x', 'linux', [], { stdin: 'ignore', signal: ctl.signal, spawn: fakeSpawn, killGraceMs: 30 })([], {}, false)
    ctl.abort()
    const r = await p
    expect(kills).toBe(1)
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/cancelled/)
  })
  it('does not start anything when the signal already aborted', async () => {
    const ctl = new AbortController()
    ctl.abort()
    let out = ''
    const r = await realRunner(process.execPath, process.platform, waitForever, { stdin: 'ignore', signal: ctl.signal, onStdout: (c) => { out += c } })([], process.env, false)
    expect(r.code).not.toBe(0)
    expect(out).toBe('')
  })
})

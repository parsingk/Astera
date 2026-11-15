import { describe, it, expect } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { probeReviewer } from './probe'
import { nodeProcFactory } from '../sessions/nodeProcFactory'
import type { ProcFactory, ProcLike } from '../sessions/proc'

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'fakeAgent.mjs')
const base = { cwd: os.tmpdir(), spawn: nodeProcFactory, baseEnv: process.env, platform: process.platform, clientVersion: 't' }
const fake = (mode: string) => ({ command: process.execPath, args: [fixture, mode] })

describe('probeReviewer', () => {
  it('answers the agent info after initialize and session/new', async () => {
    const r = await probeReviewer({ ...base, reviewer: fake('approve') })
    expect(r).toEqual({ ok: true, agent: { name: 'fake-agent', title: 'Fake Agent', version: '0.0.1' } })
  }, 20_000)

  it('maps a sign-in request to sign-in', async () => {
    const r = await probeReviewer({ ...base, reviewer: fake('auth-required') })
    expect(r).toMatchObject({ ok: false, kind: 'sign-in' })
  }, 20_000)

  it('maps an unsupported protocol version', async () => {
    const r = await probeReviewer({ ...base, reviewer: fake('bad-version') })
    expect(r).toMatchObject({ ok: false, kind: 'unsupported-version' })
  }, 20_000)

  it('answers not-found for a command that never got a pid', async () => {
    const r = await probeReviewer({ ...base, reviewer: { command: 'astera-no-such-reviewer-command', args: [] } })
    expect(r).toMatchObject({ ok: false, kind: 'not-found' })
  }, 20_000)

  it('answers timeout when initialize is not answered, and kills the process it started', async () => {
    const pids: number[] = []
    const kills: number[] = []
    const spy: ProcFactory = (f, a, o): ProcLike => {
      const p = nodeProcFactory(f, a, o)
      pids.push(p.pid)
      const kill = p.kill
      return { ...p, get pid() { return p.pid }, onLine: p.onLine, onExit: p.onExit, write: p.write, kill: () => { kills.push(p.pid); kill() } }
    }
    const r = await probeReviewer({ ...base, spawn: spy, reviewer: fake('hang-initialize'), timeouts: { initializeMs: 300 } })
    expect(r).toMatchObject({ ok: false, kind: 'timeout' })
    expect(pids.length).toBe(1)
    // once, though the client's timeout and the probe's own cleanup both end it (follow-up R4)
    expect(kills.length).toBe(1)
    expect(new Set(kills)).toEqual(new Set(pids))
  }, 20_000)

  it('never throws when the spawn itself throws', async () => {
    const r = await probeReviewer({ ...base, spawn: () => { throw new Error('boom') }, reviewer: fake('approve') })
    expect(r).toMatchObject({ ok: false, kind: 'protocol', message: expect.stringContaining('boom') })
  })

  it('kills the process after a success', async () => {
    const kills: number[] = []
    const spy: ProcFactory = (f, a, o): ProcLike => {
      const p = nodeProcFactory(f, a, o)
      const kill = p.kill
      return { ...p, onLine: p.onLine, onExit: p.onExit, write: p.write, get pid() { return p.pid }, kill: () => { kills.push(p.pid); kill() } }
    }
    await probeReviewer({ ...base, spawn: spy, reviewer: fake('approve') })
    expect(kills.length).toBe(1)
  }, 20_000)
})

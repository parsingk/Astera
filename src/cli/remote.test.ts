import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { answerRemote, type RemoteDeps } from './remote'
import { controllerRegistry } from './runtimes'
import { RemoteError } from '../core/remote/client'
import type { RemoteLink, RemoteTarget } from '../core/remote/link'

const FP = 'F'.repeat(43)
let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-remote-cli-'))
  const reg = await controllerRegistry(dir)
  await reg.add({ runtimeId: 'rt_a', name: 'Office', address: '10.0.0.2', port: 47831, fingerprint: FP, permission: 'full-control', createdAt: 'x', lastSeenAt: null }, 'tok-a')
})
afterEach(async () => fs.rm(dir, { recursive: true, force: true }))

/** A link that records what it was asked and answers through `answer`. */
function deps(answer: (cmd: string, args: Record<string, unknown>, o?: { request?: string }) => Awaited<ReturnType<RemoteLink['call']>> = () => ({ status: 200, body: [] })) {
  const calls: Array<{ cmd: string; args: Record<string, unknown>; o?: { request?: string; timeoutMs?: number } }> = []
  const targets: RemoteTarget[] = []
  let registryReads = 0
  const d: RemoteDeps = {
    registry: async () => {
      registryReads++
      return controllerRegistry(dir)
    },
    link: (t) => {
      targets.push(t)
      return {
        hello: () => null,
        call: async (cmd, args, o) => {
          calls.push({ cmd, args, ...(o ? { o } : {}) })
          return answer(cmd, args, o)
        },
        close: () => {}
      }
    }
  }
  return { d, calls, targets, registryReads: () => registryReads }
}

const ask = (cmd: string, args: Record<string, unknown>, d: RemoteDeps, runtime = 'rt_a') =>
  answerRemote({ cmd, args, runtime, request: 'req-1', profileDir: dir, mode: 'json', write: () => {}, version: '1.4.8', deps: d })

describe('answerRemote (remote runtime design §2.8, X1-14)', () => {
  it('refuses a command with no remote form before it reads anything here', async () => {
    const h = deps()
    for (const cmd of ['host-start', 'skills-list', 'mcp-status', 'projects-add', 'runtime-pair', 'version', 'browser-js']) {
      const r = await ask(cmd, {}, h.d)
      expect(r, cmd).toMatchObject({ error: { code: 'RUNTIME_CAPABILITY_MISSING' } })
    }
    expect(h.registryReads()).toBe(0)
    expect(h.calls).toEqual([])
  })

  it('a remote jobs create needs --cwd, and sends it as typed', async () => {
    const h = deps(() => ({ status: 200, body: { id: 'job_1' } }))
    expect(await ask('jobs-create', { objective: 'o' }, h.d)).toMatchObject({ error: { code: 'INVALID_ARGUMENTS', message: expect.stringMatching(/--cwd/) } })
    expect(h.calls).toEqual([])
    await ask('jobs-create', { objective: 'o', cwd: 'relative/dir' }, h.d)
    expect(h.calls[0].args).toEqual({ objective: 'o', cwd: 'relative/dir' })
  })

  it('reaches the named Runtime with its stored token, by id or by name', async () => {
    const h = deps()
    await ask('jobs-list', {}, h.d, 'office')
    expect(h.targets[0]).toEqual({ runtimeId: 'rt_a', address: '10.0.0.2', port: 47831, fingerprint: FP, token: 'tok-a' })
  })

  it('an unknown Runtime is RUNTIME_NOT_FOUND', async () => {
    expect(await ask('jobs-list', {}, deps().d, 'nope')).toMatchObject({ error: { code: 'RUNTIME_NOT_FOUND' } })
  })

  it('a change carries the request id, a read carries none', async () => {
    const h = deps(() => ({ status: 200, body: {} }))
    await ask('jobs-run', { id: 'job_1' }, h.d)
    await ask('jobs-list', {}, h.d)
    expect(h.calls.map((c) => c.o?.request)).toEqual(['req-1', undefined])
  })

  it('outcome unknown carries the request id and the line that lists the newest Jobs', async () => {
    const h = deps(() => new RemoteError('RUNTIME_OUTCOME_UNKNOWN', 'the answer was lost'))
    const r = await ask('jobs-run', { id: 'job_1' }, h.d)
    expect(r).toMatchObject({ error: { code: 'RUNTIME_OUTCOME_UNKNOWN', details: { runtime: 'rt_a', requestId: 'req-1' } } })
  })

  it('an unreachable Runtime is RUNTIME_OFFLINE, and nothing is written in this profile', async () => {
    const before = (await fs.readdir(dir)).sort()
    const h = deps(() => new RemoteError('RUNTIME_OFFLINE', 'connect ECONNREFUSED'))
    expect(await ask('send', { type: 'worker_done', taskId: 't', dispatchId: 'd', outcome: 'succeeded' }, h.d)).toMatchObject({
      error: { code: 'RUNTIME_CAPABILITY_MISSING' }
    })
    expect(await ask('jobs-list', {}, h.d)).toMatchObject({ error: { code: 'RUNTIME_OFFLINE' } })
    expect((await fs.readdir(dir)).sort()).toEqual(before)
  })

  it("a Runtime's refusal keeps its own answer for the shared rendering", async () => {
    const h = deps(() => ({ status: 403, body: { error: 'needs full control', code: 'RUNTIME_PERMISSION_DENIED' } }))
    expect(await ask('runs-stop', { id: 'run_1' }, h.d)).toEqual({ status: 403, body: { error: 'needs full control', code: 'RUNTIME_PERMISSION_DENIED' } })
  })

  it('runs follow is the same loop of calls, over the link', async () => {
    let n = 0
    const h = deps(() => {
      n++
      return n === 1
        ? { status: 200, body: { events: [{ at: '2026-10-08T00:00:00.000Z', text: 'started' }], ending: null } }
        : { status: 200, body: { events: [{ at: '2026-10-08T00:00:00.000Z', text: 'started' }], ending: { state: 'completed' } } }
    })
    const lines: string[] = []
    const r = await answerRemote({ cmd: 'runs-follow', args: { id: 'run_1' }, runtime: 'rt_a', request: 'req-1', profileDir: dir, mode: 'json', write: (l) => lines.push(l), version: '1.4.8', deps: h.d })
    expect(r).toMatchObject({ status: 200, body: { state: 'completed' } })
    expect(h.calls.every((c) => c.cmd === 'runs-follow' && c.o?.request === undefined)).toBe(true)
  })
})

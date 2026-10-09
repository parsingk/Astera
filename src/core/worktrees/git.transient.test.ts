import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execFile } from 'node:child_process'
import { git, listBranches, GIT_MAX_BUFFER_BYTES, GIT_WRITE_TIMEOUT_MS } from './git'

// The adapter's own tests (git.test.ts) run real git. What they cannot produce is a spawn that fails
// before git runs — on Windows, under heavy parallel spawning, CreateProcess is refused with EPERM
// now and then and works a moment later. That took out about one full-suite run in ten, in whichever
// test happened to spawn git at that moment. So execFile alone is replaced here, in a file of its own
// so the mock cannot leak into the real-git tests.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: vi.fn() }
})

type Cb = (err: unknown, stdout: string, stderr: string) => void
const mocked = vi.mocked(execFile) as unknown as { mockImplementationOnce(fn: (...a: unknown[]) => unknown): void; mock: { calls: unknown[][] } }
const callback = (a: unknown[]): Cb => a[a.length - 1] as Cb
const eperm = (): Error => Object.assign(new Error('spawn EPERM'), { code: 'EPERM', syscall: 'spawn git' })
const succeed = (): void => { mocked.mockImplementationOnce((...a) => { callback(a)(null, 'main\n', ''); return {} }) }

beforeEach(() => { vi.mocked(execFile).mockReset() })

describe('git adapter, spawn failures', () => {
  it('a spawn that throws synchronously resolves ok=false instead of rejecting', async () => {
    mocked.mockImplementationOnce(() => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) })
    const r = await git(['status'])
    expect(r.ok).toBe(false)
    expect(r.stderr).toContain('ENOENT')
    expect(mocked.mock.calls.length).toBe(1)
  })

  it('a synchronous EPERM is retried once and the retry answers', async () => {
    mocked.mockImplementationOnce(() => { throw eperm() })
    succeed()
    const r = await git(['branch', '--show-current'])
    expect(r).toEqual({ ok: true, stdout: 'main', stderr: '' })
    expect(mocked.mock.calls.length).toBe(2)
  })

  it('an EPERM delivered through the callback is retried once too', async () => {
    mocked.mockImplementationOnce((...a) => { callback(a)(eperm(), '', ''); return {} })
    succeed()
    const r = await git(['branch', '--show-current'])
    expect(r.ok).toBe(true)
    expect(mocked.mock.calls.length).toBe(2)
  })

  it('two EPERMs in a row give up after the one retry', async () => {
    mocked.mockImplementationOnce(() => { throw eperm() })
    mocked.mockImplementationOnce(() => { throw eperm() })
    const r = await git(['status'])
    expect(r.ok).toBe(false)
    expect(r.stderr).toContain('EPERM')
    expect(mocked.mock.calls.length).toBe(2)
  })

  it('a failure git itself reports is not retried', async () => {
    mocked.mockImplementationOnce((...a) => { callback(a)(Object.assign(new Error('exit 128'), { code: 128 }), '', 'fatal: not a git repository'); return {} })
    const r = await git(['status'])
    expect(r).toEqual({ ok: false, stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 })
    expect(mocked.mock.calls.length).toBe(1)
  })

  // exitCode says git ran and answered. A call killed at its deadline, or one that never started,
  // did not answer, and a caller must be able to tell that apart from git's own refusal.
  it('a call killed at its deadline, or one that never started, carries no exitCode', async () => {
    mocked.mockImplementationOnce((...a) => {
      callback(a)(Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM', code: null }), '', '')
      return {}
    })
    expect((await git(['status'])).exitCode).toBeUndefined()
    mocked.mockImplementationOnce(() => {
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
    })
    expect((await git(['status'])).exitCode).toBeUndefined()
  })
})

const optsOf = (call: unknown[]): { maxBuffer?: number; timeout?: number } => call[2] as { maxBuffer?: number; timeout?: number }

describe('git adapter, output limit', () => {
  // Node's default is 1 MiB. `status --untracked-files=all` or `for-each-ref` on a big repo passes
  // that easily, and execFile then fails the call — which every caller used to read as "empty".
  it('passes a 64 MiB maxBuffer to execFile, not the 1 MiB default', async () => {
    succeed()
    await git(['status'])
    expect(GIT_MAX_BUFFER_BYTES).toBe(64 * 1024 * 1024)
    expect(optsOf(mocked.mock.calls[0]).maxBuffer).toBe(GIT_MAX_BUFFER_BYTES)
  })

  // The adapter keeps the deadline itself (not execFile's `timeout`): at the deadline it kills the
  // process tree and answers as soon as git exits, instead of killing git alone and waiting for pipes a
  // hook or helper still holds.
  it('the write timeout is ten minutes and is kept as given — the call ends exactly at it', async () => {
    vi.useFakeTimers()
    try {
      const child = Object.assign(new (await import('node:events')).EventEmitter(), {
        pid: 4242, exitCode: null as number | null, signalCode: null, kill: vi.fn(() => true)
      })
      mocked.mockImplementationOnce(() => child) // git: never answers on its own
      mocked.mockImplementationOnce(() => { setTimeout(() => child.emit('exit', 1), 10); return {} }) // taskkill, on win32
      let done: unknown = null
      void git(['merge', '--no-edit', 'x'], { timeoutMs: GIT_WRITE_TIMEOUT_MS }).then((r) => (done = r))
      expect(GIT_WRITE_TIMEOUT_MS).toBe(10 * 60 * 1000)
      expect(optsOf(mocked.mock.calls[0]).timeout).toBeUndefined()
      await vi.advanceTimersByTimeAsync(GIT_WRITE_TIMEOUT_MS - 1)
      expect(done).toBeNull()
      expect(child.kill).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      // On win32 the tree goes first through taskkill, and the parent only after it answered (final review I-1);
      // elsewhere the child is killed at once.
      if (process.platform === 'win32') expect(mocked.mock.calls[1]?.[0]).toBe('taskkill')
      else expect(child.kill).toHaveBeenCalled()
      if (process.platform !== 'win32') child.emit('exit', null)
      await vi.advanceTimersByTimeAsync(20)
      expect(done).toEqual({ ok: false, stdout: '', stderr: 'timed out', timedOut: true })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('listBranches, unknown is not empty', () => {
  it('a timed-out for-each-ref gives null, not []', async () => {
    mocked.mockImplementationOnce((...a) => {
      callback(a)(Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }), '', '')
      return {}
    })
    expect(await listBranches('/repo')).toBeNull()
  })

  it('an output-limit failure gives null, not []', async () => {
    mocked.mockImplementationOnce((...a) => {
      callback(a)(Object.assign(new Error('maxBuffer'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }), '', '')
      return {}
    })
    expect(await listBranches('/repo')).toBeNull()
  })
})

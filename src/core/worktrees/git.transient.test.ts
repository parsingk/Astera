import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execFile } from 'node:child_process'
import { git } from './git'

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
    expect(r).toEqual({ ok: false, stdout: '', stderr: 'fatal: not a git repository' })
    expect(mocked.mock.calls.length).toBe(1)
  })
})

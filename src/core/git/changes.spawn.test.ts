// The git that changes.ts spawns itself (follow-up R2). Its cwd is a repository the reviewed work can write, and libuv looks
// a bare name up in the child's cwd first, so it must be the executable PATH names (windowsExecutable), as the git adapter
// does (worktrees/git.ts). spawn and the resolution are replaced here, in a file of their own so the mocks cannot leak into
// the real-git tests (the same arrangement as worktrees/git.transient.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})
vi.mock('../sessions/windowsExecutable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sessions/windowsExecutable')>()
  return { ...actual, windowsExecutable: (name: string) => `C:/Program Files/Git/cmd/${name}.exe` }
})
// trackedTreeState's HEAD and status reads go through the adapter, which has its own tests
vi.mock('../worktrees/git', () => ({ git: async () => ({ ok: true, stdout: 'abc', stderr: '' }) }))

const { readRangeDiff, trackedTreeState } = await import('./changes')

const mocked = vi.mocked(spawn) as unknown as { mockImplementation(fn: (...a: unknown[]) => unknown): void; mock: { calls: unknown[][] } }
/** A child that prints `out` and exits 0 */
const child = (out: string): EventEmitter & { stdout: EventEmitter; kill(): void } => {
  const c = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: () => {} })
  setImmediate(() => {
    c.stdout.emit('data', Buffer.from(out))
    c.emit('close', 0)
  })
  return c
}

beforeEach(() => {
  vi.mocked(spawn).mockReset()
})

describe('the git changes.ts spawns', () => {
  it('trackedTreeState hashes the diff with the git PATH names, never the bare name', async () => {
    mocked.mockImplementation(() => child('diff --git a/x b/x\n'))
    expect(await trackedTreeState('C:/repo')).not.toBeNull()
    expect(mocked.mock.calls.map((c) => c[0])).toEqual(['C:/Program Files/Git/cmd/git.exe'])
  })

  it('readRangeDiff reads the diff with the git PATH names, never the bare name', async () => {
    mocked.mockImplementation(() => child('+x\n'))
    expect(await readRangeDiff('C:/repo', 'a', 'b')).toEqual({ diff: '+x\n', truncated: false })
    expect(mocked.mock.calls.map((c) => c[0])).toEqual(['C:/Program Files/Git/cmd/git.exe'])
  })

  it('a spawn that throws makes trackedTreeState answer null, not reject', async () => {
    mocked.mockImplementation(() => {
      throw Object.assign(new Error('spawn EPERM'), { code: 'EPERM' })
    })
    await expect(trackedTreeState('C:/repo')).resolves.toBeNull()
  })

  it('an error on the diff stream makes trackedTreeState answer null, not throw', async () => {
    mocked.mockImplementation(() => {
      const c = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: () => {} })
      setImmediate(() => {
        c.stdout.emit('error', new Error('EPIPE'))
        c.emit('close', 1)
      })
      return c
    })
    await expect(trackedTreeState('C:/repo')).resolves.toBeNull()
  })
})

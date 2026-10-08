import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

// fs.watch is replaced by a fake the test drives (see transcriptWatcher.test.ts for why). Like the
// real one, the fake throws for a directory that is not there.
type Fake = EventEmitter & { dir: string; closed: boolean; listener: (e: string, f: string | null) => void; close(): void }
const fakes = vi.hoisted(() => ({ list: [] as unknown[] }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const { EventEmitter: EE } = await import('node:events')
  return {
    ...actual,
    watch: vi.fn((dir: string, listener: (e: string, f: string | null) => void) => {
      if (!actual.existsSync(dir)) throw Object.assign(new Error(`ENOENT: no such file or directory, watch '${dir}'`), { code: 'ENOENT' })
      const w = Object.assign(new EE(), { dir, closed: false, listener, close: () => (w.closed = true) })
      fakes.list.push(w)
      return w
    })
  }
})

import { mkdtempSync, mkdirSync, appendFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { createGitDirWatcher } from './gitDirWatcher'
import { stampOf } from './dirWatch'
import { dirIdentity } from '../../files/watchedDir'

/** The sweep's reads answered within the tick a fake timer advances (the real ones answer on node's pool) */
const syncReads = { stat: async (p: string) => stampOf(p), identity: async (d: string) => dirIdentity(d) }
import { gitDir } from '../../worktrees/git'

const live = (dir: string): Fake[] => (fakes.list as Fake[]).filter((w) => w.dir === dir && !w.closed)
const emit = (dir: string, name: string, event = 'change'): void => {
  const ws = live(dir)
  expect(ws).toHaveLength(1)
  ws[0].listener(event, name)
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('createGitDirWatcher', () => {
  let root: string
  let repo: string
  let gd: string
  let logsDir: string
  let changes: string[]
  let logs: string[]
  let w: ReturnType<typeof createGitDirWatcher> | null

  beforeEach(() => {
    fakes.list.length = 0
    root = mkdtempSync(path.join(os.tmpdir(), 'astera-gwatch-'))
    repo = path.join(root, 'repo')
    gd = path.join(repo, '.git')
    logsDir = path.join(gd, 'logs')
    mkdirSync(logsDir, { recursive: true })
    writeFileSync(path.join(gd, 'index'), 'i0')
    writeFileSync(path.join(gd, 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(path.join(logsDir, 'HEAD'), 'r0\n')
    changes = []
    logs = []
    w = null
  })
  afterEach(() => {
    w?.close()
    vi.useRealTimers()
    rmSync(root, { recursive: true, force: true })
  })
  const make = (
    over: Partial<Parameters<typeof createGitDirWatcher>[0]> = {}
  ): ReturnType<typeof createGitDirWatcher> =>
    (w = createGitDirWatcher({
      onChange: (r) => changes.push(r),
      log: (m) => logs.push(m),
      gitDir: async () => gd,
      sweepMs: 60_000,
      debounceMs: 20,
      reads: syncReads,
      ...over
    }))
  /** Lets the injected gitDir promise settle under fake timers. */
  const settle = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0)
  }

  it('index, HEAD and logs/HEAD changes seen by fs.watch reach onChange once per burst', async () => {
    vi.useFakeTimers()
    const t = make()
    t.watch(repo)
    await settle()
    emit(gd, 'index')
    emit(gd, 'HEAD')
    emit(logsDir, 'HEAD')
    await vi.advanceTimersByTimeAsync(50)
    expect(changes).toEqual([repo])
    emit(logsDir, 'HEAD')
    await vi.advanceTimersByTimeAsync(50)
    expect(changes).toEqual([repo, repo])
  })

  it('other git files do not: FETCH_HEAD, ORIG_HEAD, a lock alone, logs/refs', async () => {
    vi.useFakeTimers()
    const t = make()
    t.watch(repo)
    await settle()
    for (const n of ['FETCH_HEAD', 'ORIG_HEAD', 'index.lock', 'HEAD.lock', 'objects', 'logs', 'packed-refs']) emit(gd, n)
    emit(logsDir, 'refs')
    await vi.advanceTimersByTimeAsync(500)
    expect(changes).toEqual([])
  })

  it("git's lock-file rename into index reaches onChange once", async () => {
    vi.useFakeTimers()
    const t = make()
    t.watch(repo)
    await settle()
    writeFileSync(path.join(gd, 'index.lock'), 'i1-longer')
    emit(gd, 'index.lock', 'rename')
    renameSync(path.join(gd, 'index.lock'), path.join(gd, 'index'))
    emit(gd, 'index.lock', 'rename')
    emit(gd, 'index', 'rename')
    await vi.advanceTimersByTimeAsync(500)
    expect(changes).toEqual([repo])
    // The watch is on the directory, so it outlives the swap.
    expect(live(gd)).toHaveLength(1)
  })

  it('changes seen only by the sweep: index by rename, HEAD rewritten, logs/HEAD appended', async () => {
    vi.useFakeTimers()
    const t = make({ sweepMs: 1000 })
    t.watch(repo)
    await settle()
    await vi.advanceTimersByTimeAsync(5000)
    expect(changes).toEqual([])
    writeFileSync(path.join(gd, 'index.lock'), 'i1-longer')
    renameSync(path.join(gd, 'index.lock'), path.join(gd, 'index'))
    await vi.advanceTimersByTimeAsync(1000 + 20)
    expect(changes).toHaveLength(1)
    writeFileSync(path.join(gd, 'HEAD'), 'ref: refs/heads/feature\n')
    await vi.advanceTimersByTimeAsync(1000 + 20)
    expect(changes).toHaveLength(2)
    appendFileSync(path.join(logsDir, 'HEAD'), 'r1\n')
    await vi.advanceTimersByTimeAsync(1000 + 20)
    expect(changes).toEqual([repo, repo, repo])
    await vi.advanceTimersByTimeAsync(5000)
    expect(changes).toHaveLength(3)
  })

  it('a fresh repo whose logs/ appears later: the sweep sees logs/HEAD and arms the logs watch', async () => {
    vi.useFakeTimers()
    rmSync(logsDir, { recursive: true })
    const t = make({ sweepMs: 1000 })
    t.watch(repo)
    await settle()
    await vi.advanceTimersByTimeAsync(3000)
    expect(logs.filter((l) => l.includes(logsDir))).toHaveLength(1)
    mkdirSync(logsDir)
    writeFileSync(path.join(logsDir, 'HEAD'), 'r0\n')
    await vi.advanceTimersByTimeAsync(1000 + 20)
    expect(changes).toEqual([repo])
    emit(logsDir, 'HEAD')
    await vi.advanceTimersByTimeAsync(20)
    expect(changes).toEqual([repo, repo])
  })

  it('not a repository, or gitDir failing: logged, nothing watched, nothing thrown', async () => {
    vi.useFakeTimers()
    const a = make({ gitDir: async () => null })
    expect(() => a.watch(repo)).not.toThrow()
    await settle()
    a.close()
    const b = make({ gitDir: async () => Promise.reject(new Error('git not found')) })
    b.watch(repo)
    await settle()
    b.close()
    const c = make({ gitDir: () => { throw new Error('sync boom') } })
    expect(() => c.watch(repo)).not.toThrow()
    await settle()
    expect(fakes.list).toHaveLength(0)
    expect(logs.some((l) => l.includes('not a git repository'))).toBe(true)
    expect(logs.some((l) => l.includes('git not found'))).toBe(true)
    expect(logs.some((l) => l.includes('sync boom'))).toBe(true)
  })

  it('a root whose gitDir failed (null, reject, sync throw) is asked again on the next watch', async () => {
    vi.useFakeTimers()
    for (const first of [
      async (): Promise<string | null> => null,
      async (): Promise<string | null> => Promise.reject(new Error('git timed out')),
      (): Promise<string | null> => {
        throw new Error('sync boom')
      }
    ]) {
      fakes.list.length = 0
      let calls = 0
      const t = make({ gitDir: () => (++calls === 1 ? first() : Promise.resolve(gd)) })
      t.watch(repo)
      await settle()
      expect(fakes.list).toHaveLength(0)
      t.watch(repo)
      await settle()
      expect(calls).toBe(2)
      expect(live(gd)).toHaveLength(1)
      t.close()
    }
  })

  it('a gitDir rejection that settles after unwatch or close is dropped, not logged', async () => {
    vi.useFakeTimers()
    let reject: (e: Error) => void = () => {}
    const t = make({ gitDir: () => new Promise<string | null>((_res, rej) => (reject = rej)) })
    t.watch(repo)
    t.unwatch(repo)
    reject(new Error('late failure one'))
    await settle()
    t.watch(repo)
    t.close()
    reject(new Error('late failure two'))
    await settle()
    expect(logs.filter((l) => l.includes('late failure'))).toEqual([])
  })

  it('a watched git dir that is deleted and recreated is re-armed by the sweep, with no error event', async () => {
    vi.useFakeTimers()
    const t = make({ sweepMs: 1000 })
    t.watch(repo)
    await settle()
    const first = live(logsDir)[0]
    rmSync(logsDir, { recursive: true }) // Linux and macOS raise no error event for this
    await vi.advanceTimersByTimeAsync(1000)
    expect(first.closed).toBe(true)
    mkdirSync(logsDir)
    writeFileSync(path.join(logsDir, 'HEAD'), 'r0\n')
    await vi.advanceTimersByTimeAsync(1000)
    expect(live(logsDir)).toHaveLength(1)
    expect(live(logsDir)[0]).not.toBe(first)
  })

  it('the same root spelled differently is one entry, reported resolved', async () => {
    vi.useFakeTimers()
    const asked: string[] = []
    const t = make({ gitDir: async (r) => (asked.push(r), gd) })
    t.watch(repo)
    t.watch(`${repo}/sub/..`) // a template, not path.join, which would normalise it
    await settle()
    expect(asked).toEqual([path.resolve(repo)])
    emit(gd, 'HEAD')
    await vi.advanceTimersByTimeAsync(50)
    expect(changes).toEqual([path.resolve(repo)])
    t.unwatch(`${repo}/.`)
    expect(live(gd)).toHaveLength(0)
  })

  it('a throwing onChange is logged, not thrown', async () => {
    vi.useFakeTimers()
    const t = make({ onChange: () => { throw new Error('consumer broke') } })
    t.watch(repo)
    await settle()
    emit(gd, 'HEAD')
    await expect(vi.advanceTimersByTimeAsync(50)).resolves.not.toThrow()
    expect(logs.some((l) => l.includes('consumer broke'))).toBe(true)
  })

  it('unwatch stops events, even one before gitDir answered', async () => {
    vi.useFakeTimers()
    const t = make({ sweepMs: 1000 })
    t.watch(repo)
    t.unwatch(repo) // gitDir has not settled yet
    await settle()
    expect(fakes.list).toHaveLength(0)
    t.watch(repo)
    await settle()
    emit(gd, 'HEAD')
    t.unwatch(repo)
    appendFileSync(path.join(logsDir, 'HEAD'), 'r1\n')
    await vi.advanceTimersByTimeAsync(5000)
    expect(changes).toEqual([])
    expect(live(gd)).toHaveLength(0)
    expect(live(logsDir)).toHaveLength(0)
  })

  it('close clears every timer and closes every watch', async () => {
    vi.useFakeTimers()
    const t = make({ sweepMs: 1000 })
    t.watch(repo)
    await settle()
    emit(gd, 'index')
    t.close()
    expect(vi.getTimerCount()).toBe(0)
    expect(live(gd)).toHaveLength(0)
    expect(live(logsDir)).toHaveLength(0)
  })

  it('a real repository and the real gitDir: a commit is seen by the sweep alone', async () => {
    const real = path.join(root, 'real')
    mkdirSync(real)
    const g = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: real, stdio: 'ignore' })
    }
    g('init', '-q')
    writeFileSync(path.join(real, 'a.txt'), 'a')
    const t = make({ gitDir, sweepMs: 30, debounceMs: 10 })
    t.watch(real)
    await waitFor(() => fakes.list.length > 0) // the git dir is resolved and watched
    g('add', 'a.txt')
    g('commit', '-q', '-m', 'first')
    await waitFor(() => changes.length > 0)
    expect(changes[0]).toBe(real)
  })

  // Performance audit H3, as for transcripts: a git dir whose check was slow is left out of the sweep for a while.
  it('a git dir whose check was slow is left out of the sweep for a while, and said once', async () => {
    vi.useFakeTimers()
    let t = 0
    const g = make({ sweepMs: 1000, now: () => (t += 2000) })
    g.watch(root)
    await vi.advanceTimersByTimeAsync(0)
    writeFileSync(path.join(gd, 'index'), 'i1-changed')
    await vi.advanceTimersByTimeAsync(1000 + 20)
    expect(changes).toEqual([root])
    writeFileSync(path.join(gd, 'index'), 'i2-changed-again')
    await vi.advanceTimersByTimeAsync(5000)
    expect(changes).toEqual([root])
    expect(logs.filter((l) => l.includes('slow')).length).toBe(1)
  })
})

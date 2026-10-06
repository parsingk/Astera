import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// chokidar 를 가짜로 바꾼다 — 여기서 보려는 것은 감시가 아니라, 감시 이벤트가 IPC 로 나가는 모양이다
const fakes: (EventEmitter & { close: () => Promise<void> })[] = []
vi.mock('chokidar', () => ({
  default: {
    watch: () => {
      const w = Object.assign(new EventEmitter(), { close: async () => {} })
      fakes.push(w)
      return w
    }
  }
}))

import { FileWatcher, type NativeWatch } from './fileWatcher'
import { FILE_CHANGE_BATCH_MS, type FileChangeBatch } from '../core/files/changeBatch'

afterEach(() => {
  fakes.splice(0)
  vi.useRealTimers()
})

describe('FileWatcher — 감시 이벤트를 묶어 보낸다', () => {
  it('git checkout 처럼 1000 개의 이벤트가 쏟아져도 IPC 전송은 한 번이다', async () => {
    const root = path.join(os.tmpdir(), 'astera-no-such-root-fw')
    const send = vi.fn<(b: FileChangeBatch) => void>()
    const w = new FileWatcher(send, undefined, { platform: 'linux' })
    await w.watch(root)
    vi.useFakeTimers()
    const chok = fakes[0]
    for (let i = 0; i < 1000; i++) chok.emit('add', path.join(root, `d${i % 10}`, `f${i}.js`))
    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(FILE_CHANGE_BATCH_MS)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].parents).toHaveLength(10)
    vi.useRealTimers()
    await w.unwatch()
  })

  // 감시를 멈출 때 창에 남은 이벤트는 버리지 않고 바로 보낸다 — 열린 버퍼가 마지막 변경을 놓치지 않게
  it('unwatch 는 모아 둔 이벤트를 바로 내보낸다', async () => {
    const root = path.join(os.tmpdir(), 'astera-no-such-root-fw2')
    const send = vi.fn<(b: FileChangeBatch) => void>()
    const w = new FileWatcher(send, undefined, { platform: 'linux' })
    await w.watch(root)
    fakes[0].emit('unlink', path.join(root, 'a.txt'))
    await w.unwatch()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].changes).toEqual([{ path: path.join(root, 'a.txt'), kind: 'unlink' }])
  })

  it('chokidar 쪽에서는 quietWhile 이 감시를 건드리지 않고 작업만 돌린다', async () => {
    const root = path.join(os.tmpdir(), 'astera-no-such-root-fw3')
    const w = new FileWatcher(vi.fn(), undefined, { platform: 'linux' })
    await w.watch(root)
    await expect(w.quietWhile([path.join(root, 'x')], async () => 7)).resolves.toBe(7)
    expect(fakes).toHaveLength(1)
    await w.unwatch()
  })
})

/** A native recursive handle the test drives: `fire` is what fs.watch's listener would hear. */
function fakeNative(): { watch: NativeWatch; opened: string[]; closed: number; fire: (type: string, name: string | null) => void } {
  const state = { opened: [] as string[], closed: 0, listener: null as ((t: string, n: string | null) => void) | null }
  const watch: NativeWatch = (root, listener) => {
    state.opened.push(root)
    state.listener = listener
    return Object.assign(new EventEmitter(), {
      close: () => {
        state.closed++
        state.listener = null
      }
    })
  }
  return {
    watch,
    get opened() {
      return state.opened
    },
    get closed() {
      return state.closed
    },
    fire: (type, name) => state.listener?.(type, name)
  }
}

async function tmpRoot(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'astera-fw-')))
}

/** Lets the listener's lstat settle, then closes the batching window. */
async function settle(w: FileWatcher): Promise<void> {
  await new Promise((r) => setTimeout(r, 50))
  await w.unwatch()
}

// Windows: chokidar puts an fs.watch on every file, and there one file's watch is its whole folder's,
// so each change in a folder of thousands wakes thousands of handles — deleting 6000 files took 290s
// against 0.16s unwatched (measured 2026-09-29). One native recursive handle instead.
describe('FileWatcher — win32 는 기본 재귀 감시 하나를 쓴다', () => {
  it('rename 은 지금 있는지로 add·addDir·unlink 를 가르고, change 는 그대로 보낸다', async () => {
    const root = await tmpRoot()
    await fs.writeFile(path.join(root, 'new.txt'), 'x')
    await fs.mkdir(path.join(root, 'newdir'))
    const native = fakeNative()
    const send = vi.fn<(b: FileChangeBatch) => void>()
    const w = new FileWatcher(send, undefined, { platform: 'win32', watchNative: native.watch })
    await w.watch(root)
    expect(native.opened).toEqual([root])
    expect(fakes).toHaveLength(0)
    native.fire('rename', 'new.txt')
    native.fire('rename', 'newdir')
    native.fire('rename', 'gone.txt')
    native.fire('change', 'edited.txt')
    await settle(w)
    const changes = send.mock.calls.flatMap((c) => c[0].changes)
    expect(changes).toEqual(
      expect.arrayContaining([
        { path: path.join(root, 'new.txt'), kind: 'add' },
        { path: path.join(root, 'newdir'), kind: 'addDir' },
        // not there any more, and a native watcher cannot say what it was: both kinds, which the
        // renderer handles right either way (a file's open tab, a folder's cached listing)
        { path: path.join(root, 'gone.txt'), kind: 'unlinkDir' },
        { path: path.join(root, 'gone.txt'), kind: 'unlink' },
        { path: path.join(root, 'edited.txt'), kind: 'change' }
      ])
    )
    await fs.rm(root, { recursive: true, force: true })
  })

  it('무시 목록(.git, node_modules 아래)과 이름 없는 이벤트는 버린다', async () => {
    const root = await tmpRoot()
    const native = fakeNative()
    const send = vi.fn<(b: FileChangeBatch) => void>()
    const w = new FileWatcher(send, undefined, { platform: 'win32', watchNative: native.watch })
    await w.watch(root)
    native.fire('change', path.join('.git', 'index'))
    native.fire('rename', path.join('node_modules', 'pkg', 'index.js'))
    native.fire('rename', null)
    await settle(w)
    expect(send).not.toHaveBeenCalled()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('quietWhile 은 작업 동안 감시를 닫았다가 다시 열고, 그 경로의 지금 상태를 한 번 보낸다', async () => {
    const root = await tmpRoot()
    const target = path.join(root, 'big')
    await fs.mkdir(target)
    const copied = path.join(root, 'copy')
    const native = fakeNative()
    const send = vi.fn<(b: FileChangeBatch) => void>()
    const w = new FileWatcher(send, undefined, { platform: 'win32', watchNative: native.watch })
    await w.watch(root)
    const result = await w.quietWhile([target, copied], async () => {
      expect(native.closed).toBe(1) // nothing is watching while the app does the work itself
      await fs.rm(target, { recursive: true })
      await fs.mkdir(copied)
      return 'done'
    })
    expect(result).toBe('done')
    expect(native.opened).toEqual([root, root])
    await settle(w)
    const changes = send.mock.calls.flatMap((c) => c[0].changes)
    expect(changes).toEqual(
      expect.arrayContaining([
        { path: target, kind: 'unlinkDir' },
        { path: copied, kind: 'addDir' }
      ])
    )
    await fs.rm(root, { recursive: true, force: true })
  })

  it('겹친 작업은 마지막 것이 끝날 때 한 번만 다시 열고, 실패한 작업도 감시를 되돌린다', async () => {
    const root = await tmpRoot()
    const native = fakeNative()
    const w = new FileWatcher(vi.fn(), undefined, { platform: 'win32', watchNative: native.watch })
    await w.watch(root)
    let releaseA!: () => void
    const a = w.quietWhile([path.join(root, 'a')], () => new Promise<void>((r) => (releaseA = r)))
    const b = w.quietWhile([path.join(root, 'b')], async () => {
      throw new Error('EBUSY')
    })
    await expect(b).rejects.toThrow('EBUSY')
    expect(native.opened).toEqual([root]) // a is still running
    releaseA()
    await a
    expect(native.opened).toEqual([root, root])
    await w.unwatch()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('작업 중에 감시를 끄면 작업이 끝나도 다시 열지 않는다', async () => {
    const root = await tmpRoot()
    const native = fakeNative()
    const w = new FileWatcher(vi.fn(), undefined, { platform: 'win32', watchNative: native.watch })
    await w.watch(root)
    await w.quietWhile([path.join(root, 'a')], () => w.unwatch())
    expect(native.opened).toEqual([root])
    await fs.rm(root, { recursive: true, force: true })
  })

  it('기본 감시를 못 걸면(예: 없는 루트) chokidar 로 물러선다', async () => {
    const root = path.join(os.tmpdir(), 'astera-no-such-root-fw4')
    const watchNative: NativeWatch = () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    const w = new FileWatcher(vi.fn(), undefined, { platform: 'win32', watchNative })
    await w.watch(root)
    expect(fakes).toHaveLength(1)
    await w.unwatch()
  })

  // A root removed under the handle (watchedDir.ts): win32 then fires rename events named after the
  // root's own path without a pause, and each one used to become a path joined onto the root and an
  // lstat. The handle is closed at the first of them, and the next watch of the root opens a new one.
  it('closes the handle when the root itself is removed, reports nothing for that storm, and reopens on the next watch', async () => {
    const root = await tmpRoot()
    const native = fakeNative()
    const logs: string[] = []
    const send = vi.fn<(b: FileChangeBatch) => void>()
    const w = new FileWatcher(send, (m) => logs.push(m), { platform: 'win32', watchNative: native.watch })
    await w.watch(root)
    await fs.rm(root, { recursive: true, force: true })
    for (let i = 0; i < 1000; i++) native.fire('rename', `\\\\?\\${root}`)
    expect(native.closed).toBe(1)
    expect(logs.filter((l) => l.includes('was removed or replaced'))).toHaveLength(1)
    await fs.mkdir(root)
    await w.watch(root)
    expect(native.opened).toEqual([root, root])
    await settle(w)
    expect(send).not.toHaveBeenCalled()
    await fs.rm(root, { recursive: true, force: true })
  })

  it('keeps the handle for a path-named event while the root is still the one it opened', async () => {
    const root = await tmpRoot()
    const native = fakeNative()
    const w = new FileWatcher(vi.fn(), undefined, { platform: 'win32', watchNative: native.watch })
    await w.watch(root)
    native.fire('rename', root)
    expect(native.closed).toBe(0)
    await w.unwatch()
    await fs.rm(root, { recursive: true, force: true })
  })
})

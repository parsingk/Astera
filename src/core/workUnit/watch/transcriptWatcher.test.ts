import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

// fs.watch is replaced by a fake the test drives, so no assertion waits on the OS delivering an
// event (it sometimes does not, see HookEventWatcher.sweep). A test that never emits sees only the sweep.
// Like the real one, the fake throws for a directory that is not there.
type Fake = EventEmitter & { dir: string; closed: boolean; listener: (e: string, f: string | null) => void; close(): void }
const fakes = vi.hoisted(() => ({ list: [] as unknown[], throwAll: null as string | null }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const { EventEmitter: EE } = await import('node:events')
  return {
    ...actual,
    watch: vi.fn((dir: string, listener: (e: string, f: string | null) => void) => {
      if (fakes.throwAll) throw new Error(fakes.throwAll)
      if (!actual.existsSync(dir)) throw Object.assign(new Error(`ENOENT: no such file or directory, watch '${dir}'`), { code: 'ENOENT' })
      const w = Object.assign(new EE(), { dir, closed: false, listener, close: () => (w.closed = true) })
      fakes.list.push(w)
      return w
    })
  }
})

import { mkdtempSync, mkdirSync, appendFileSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTranscriptWatcher } from './transcriptWatcher'

const live = (dir: string): Fake[] => (fakes.list as Fake[]).filter((w) => w.dir === dir && !w.closed)
const emit = (dir: string, name: string): void => {
  const ws = live(dir)
  expect(ws).toHaveLength(1)
  ws[0].listener('change', name)
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('createTranscriptWatcher', () => {
  let root: string
  let dir: string
  let file: string
  let changes: string[]
  let logs: string[]
  let w: ReturnType<typeof createTranscriptWatcher> | null

  beforeEach(() => {
    fakes.list.length = 0
    fakes.throwAll = null
    root = mkdtempSync(path.join(os.tmpdir(), 'astera-twatch-'))
    dir = path.join(root, 'proj')
    mkdirSync(dir)
    file = path.join(dir, 'sess-1.jsonl')
    writeFileSync(file, '{"n":0}\n')
    changes = []
    logs = []
    w = null
  })
  afterEach(() => {
    w?.close()
    vi.useRealTimers()
    rmSync(root, { recursive: true, force: true })
  })
  const make = (sweepMs = 60_000, debounceMs = 20): ReturnType<typeof createTranscriptWatcher> =>
    (w = createTranscriptWatcher({ onChange: (p) => changes.push(p), log: (m) => logs.push(m), sweepMs, debounceMs }))

  it('a write seen by fs.watch reaches onChange once per burst, and only for watched names', () => {
    vi.useFakeTimers()
    const t = make()
    t.watch(file)
    emit(dir, 'other.jsonl')
    vi.advanceTimersByTime(50)
    expect(changes).toEqual([])
    appendFileSync(file, '{"n":1}\n')
    emit(dir, 'sess-1.jsonl')
    emit(dir, 'sess-1.jsonl')
    vi.advanceTimersByTime(10)
    emit(dir, 'sess-1.jsonl')
    vi.advanceTimersByTime(50)
    expect(changes).toEqual([file])
    emit(dir, 'sess-1.jsonl')
    vi.advanceTimersByTime(50)
    expect(changes).toEqual([file, file])
  })

  it('two files in one directory share one fs.watch and are told apart', () => {
    vi.useFakeTimers()
    const t = make()
    const other = path.join(dir, 'sess-2.jsonl')
    t.watch(file)
    t.watch(other)
    expect(live(dir)).toHaveLength(1)
    emit(dir, 'sess-2.jsonl')
    vi.advanceTimersByTime(50)
    expect(changes).toEqual([other])
  })

  it('a change seen only by the sweep (fs.watch says nothing) reaches onChange, with real timers', async () => {
    const t = make(30, 10)
    t.watch(file)
    appendFileSync(file, '{"n":1}\n')
    await waitFor(() => changes.length > 0)
    expect(changes).toEqual([file])
  })

  it('the sweep reports nothing while the file is unchanged, and the change once', () => {
    vi.useFakeTimers()
    const t = make(1000, 20)
    t.watch(file)
    vi.advanceTimersByTime(5000)
    expect(changes).toEqual([])
    appendFileSync(file, '{"n":1}\n')
    vi.advanceTimersByTime(1000 + 20)
    expect(changes).toEqual([file])
    vi.advanceTimersByTime(5000)
    expect(changes).toEqual([file])
  })

  it('a change fs.watch already reported is not reported again by the sweep', () => {
    vi.useFakeTimers()
    const t = make(1000, 20)
    t.watch(file)
    appendFileSync(file, '{"n":1}\n')
    emit(dir, 'sess-1.jsonl')
    vi.advanceTimersByTime(20)
    expect(changes).toEqual([file])
    vi.advanceTimersByTime(5000)
    expect(changes).toEqual([file])
  })

  it('a watched file whose directory appears later is seen, and its directory is then watched', () => {
    vi.useFakeTimers()
    const t = make(1000, 20)
    const laterDir = path.join(root, 'later')
    const later = path.join(laterDir, 'sess-9.jsonl')
    expect(() => t.watch(later)).not.toThrow()
    vi.advanceTimersByTime(3000)
    expect(logs.filter((l) => l.includes(laterDir))).toHaveLength(1) // logged once, not per sweep
    expect(changes).toEqual([])
    mkdirSync(laterDir)
    writeFileSync(later, '{"n":0}\n')
    vi.advanceTimersByTime(1000 + 20)
    expect(changes).toEqual([later])
    emit(laterDir, 'sess-9.jsonl')
    vi.advanceTimersByTime(20)
    expect(changes).toEqual([later, later])
  })

  it('a watched directory that is deleted and recreated is re-armed by the sweep, with no error event', () => {
    vi.useFakeTimers()
    const t = make(1000, 20)
    t.watch(file)
    const first = live(dir)[0]
    rmSync(dir, { recursive: true }) // Linux and macOS raise no error event for this
    vi.advanceTimersByTime(1000)
    expect(first.closed).toBe(true)
    mkdirSync(dir)
    vi.advanceTimersByTime(1000)
    expect(live(dir)).toHaveLength(1)
    expect(live(dir)[0]).not.toBe(first)
    changes.length = 0
    emit(dir, 'sess-1.jsonl')
    vi.advanceTimersByTime(20)
    expect(changes).toEqual([file])
  })

  it('the same path spelled differently is one entry, reported resolved', () => {
    vi.useFakeTimers()
    const t = make()
    t.watch(file)
    t.watch(`${dir}/x/../sess-1.jsonl`) // a template, not path.join, which would normalise it
    emit(dir, 'sess-1.jsonl')
    vi.advanceTimersByTime(50)
    expect(changes).toEqual([path.resolve(file)])
    t.unwatch(`${dir}/./sess-1.jsonl`)
    expect(live(dir)).toHaveLength(0)
  })

  it('unwatch stops events, a pending one included, and closes the directory watch with its last file', () => {
    vi.useFakeTimers()
    const t = make(1000, 20)
    t.watch(file)
    appendFileSync(file, '{"n":1}\n')
    emit(dir, 'sess-1.jsonl')
    t.unwatch(file)
    vi.advanceTimersByTime(5000)
    expect(changes).toEqual([])
    expect(live(dir)).toHaveLength(0)
  })

  it('close clears every timer and closes every watch', () => {
    vi.useFakeTimers()
    const t = make(1000, 20)
    t.watch(file)
    emit(dir, 'sess-1.jsonl')
    t.close()
    expect(vi.getTimerCount()).toBe(0)
    expect(live(dir)).toHaveLength(0)
    expect(() => t.watch(file)).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('errors are logged, never thrown: a failing fs.watch, a watch error event, a throwing onChange', () => {
    vi.useFakeTimers()
    fakes.throwAll = 'EPERM: operation not permitted'
    const t = createTranscriptWatcher({
      onChange: (p) => {
        changes.push(p)
        throw new Error('consumer broke')
      },
      log: (m) => logs.push(m),
      sweepMs: 1000,
      debounceMs: 20
    })
    w = t
    expect(() => t.watch(file)).not.toThrow()
    expect(logs.some((l) => l.includes('EPERM'))).toBe(true)
    // The sweep still sees the change, and the consumer's throw stays inside.
    appendFileSync(file, '{"n":1}\n')
    expect(() => vi.advanceTimersByTime(1000 + 20)).not.toThrow()
    expect(changes).toEqual([file])
    expect(logs.some((l) => l.includes('consumer broke'))).toBe(true)
    // Once fs.watch works, an error event drops the watch and the sweep arms a new one.
    fakes.throwAll = null
    vi.advanceTimersByTime(1000)
    expect(live(dir)).toHaveLength(1)
    live(dir)[0].emit('error', new Error('watched dir went away'))
    expect(logs.some((l) => l.includes('watched dir went away'))).toBe(true)
    expect(live(dir)).toHaveLength(0)
    vi.advanceTimersByTime(1000)
    expect(live(dir)).toHaveLength(1)
  })
})

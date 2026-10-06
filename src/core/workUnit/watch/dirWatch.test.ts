import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dirWatch } from './dirWatch'

/** A watch that behaves as win32's did when the measured Host spun (2026-10-06): once its directory is
 *  removed it raises no 'error' and keeps firing 'rename' named after the directory's own path. */
function fakeWatch() {
  const made: Array<{ fire(ev: string, name: string): void; closes: number }> = []
  const watchFn = ((_dir: string, listener: (ev: string, name: string | null) => void) => {
    const w = Object.assign(new EventEmitter(), {
      closes: 0,
      close() {
        w.closes++
      },
      fire: (ev: string, name: string) => listener(ev, name)
    })
    made.push(w)
    return w
  }) as unknown as typeof import('node:fs').watch
  return { made, watchFn }
}

describe('dirWatch', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-dirwatch-'))
  })
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('hands on the child names it hears', () => {
    const { made, watchFn } = fakeWatch()
    const names: string[] = []
    const w = dirWatch(dir, (n) => names.push(n), () => {}, watchFn)
    w.arm()
    made[0].fire('change', 'index')
    expect(names).toEqual(['index'])
    w.close()
  })

  it('closes the watch at the first event after its directory was removed, and hands that storm on to nobody', async () => {
    const { made, watchFn } = fakeWatch()
    const names: string[] = []
    const logs: string[] = []
    const w = dirWatch(dir, (n) => names.push(n), (m) => logs.push(m), watchFn)
    w.arm()
    await fs.rm(dir, { recursive: true, force: true })
    for (let i = 0; i < 1000; i++) made[0].fire('rename', `\\\\?\\${dir}`)
    expect(made[0].closes).toBe(1)
    expect(w.armed()).toBe(false)
    expect(names).toEqual([])
    // One line says why the watch went.
    expect(logs.filter((l) => l.includes('closed: the directory was removed'))).toHaveLength(1)
    // The owner's sweep arms it again once the directory is back.
    await fs.mkdir(dir)
    w.arm()
    expect(made).toHaveLength(2)
    expect(w.armed()).toBe(true)
    w.close()
  })

  it('keeps the watch for a path-named event while its directory is still the one armed', () => {
    const { made, watchFn } = fakeWatch()
    const w = dirWatch(dir, () => {}, () => {}, watchFn)
    w.arm()
    made[0].fire('rename', path.join(dir, 'x'))
    expect(made[0].closes).toBe(0)
    expect(w.armed()).toBe(true)
    w.close()
  })

  it('opens no watch on a directory that is not there, says so once, and opens one once it is', async () => {
    const { made, watchFn } = fakeWatch()
    const logs: string[] = []
    await fs.rm(dir, { recursive: true, force: true })
    const w = dirWatch(dir, () => {}, (m) => logs.push(m), watchFn)
    w.arm()
    w.arm()
    expect(made).toHaveLength(0)
    expect(w.armed()).toBe(false)
    expect(logs.filter((l) => l.includes('relying on the sweep'))).toHaveLength(1)
    await fs.mkdir(dir)
    w.arm()
    expect(made).toHaveLength(1)
    // Armed on a real id, so the directory going is seen at its first event.
    await fs.rm(dir, { recursive: true, force: true })
    made[0].fire('rename', dir)
    expect(made[0].closes).toBe(1)
    w.close()
  })
})

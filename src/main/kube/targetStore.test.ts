import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { KubeTargetStore } from './targetStore'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-kube-targets-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const file = (): string => path.join(dir, 'kube-targets.json')

describe('KubeTargetStore', () => {
  it('starts empty when the file is missing', async () => {
    const store = new KubeTargetStore(file())
    expect(await store.load()).toEqual({ recovered: false })
    expect(store.get('a')).toBeUndefined()
    expect(store.getOverlay('a')).toBeUndefined()
  })

  it('round-trips targets and overlays, keys with ARNs and pipes included', async () => {
    const key = 'arn:aws:eks:us-east-1:123:cluster/x|F:/proj/k8s'
    const a = new KubeTargetStore(file())
    await a.load()
    await a.set(key, { context: 'ctx-a', namespace: 'dev' })
    await a.set('k2', { context: 'ctx-b', namespace: null })
    await a.setOverlay('f1', 'overlays/prod')
    const b = new KubeTargetStore(file())
    expect(await b.load()).toEqual({ recovered: false })
    expect(b.get(key)).toEqual({ context: 'ctx-a', namespace: 'dev' })
    expect(b.get('k2')).toEqual({ context: 'ctx-b', namespace: null })
    expect(b.getOverlay('f1')).toBe('overlays/prod')
  })

  it('set(key, null) and setOverlay(key, null) remove the key', async () => {
    const a = new KubeTargetStore(file())
    await a.load()
    await a.set('k', { context: 'c', namespace: null })
    await a.setOverlay('f', 'o')
    await a.set('k', null)
    await a.setOverlay('f', null)
    expect(a.get('k')).toBeUndefined()
    expect(a.getOverlay('f')).toBeUndefined()
    const b = new KubeTargetStore(file())
    await b.load()
    expect(b.get('k')).toBeUndefined()
    expect(b.getOverlay('f')).toBeUndefined()
  })

  it('a file that is not an object is backed up and starts empty', async () => {
    await fs.writeFile(file(), '{ not json', 'utf8')
    const store = new KubeTargetStore(file())
    expect(await store.load()).toEqual({ recovered: true })
    expect(await fs.readFile(file() + '.bak', 'utf8')).toBe('{ not json')
    expect(store.get('x')).toBeUndefined()
    await fs.writeFile(file(), '[1]', 'utf8')
    expect(await new KubeTargetStore(file()).load()).toEqual({ recovered: true })
  })

  it('drops entries of the wrong shape individually and keeps the valid ones', async () => {
    await fs.writeFile(
      file(),
      JSON.stringify({
        targets: {
          good: { context: 'c', namespace: 'n' },
          goodNull: { context: 'c', namespace: null },
          noCtx: { namespace: 'n' },
          badNs: { context: 'c', namespace: 5 },
          str: 'x'
        },
        overlays: { ok: 'dir', bad: 3 }
      }),
      'utf8'
    )
    const store = new KubeTargetStore(file())
    expect(await store.load()).toEqual({ recovered: false })
    expect(store.get('good')).toEqual({ context: 'c', namespace: 'n' })
    expect(store.get('goodNull')).toEqual({ context: 'c', namespace: null })
    expect(store.get('noCtx')).toBeUndefined()
    expect(store.get('badNs')).toBeUndefined()
    expect(store.get('str')).toBeUndefined()
    expect(store.getOverlay('ok')).toBe('dir')
    expect(store.getOverlay('bad')).toBeUndefined()
  })

  it('an object without targets or overlays loads as empty, not recovered', async () => {
    await fs.writeFile(file(), '{}', 'utf8')
    const store = new KubeTargetStore(file())
    expect(await store.load()).toEqual({ recovered: false })
    expect(store.get('a')).toBeUndefined()
  })

  it('writes are serialised: a slow older write cannot land after a newer one', async () => {
    const a = new KubeTargetStore(file())
    await a.load()
    const realWriteFile = fs.writeFile.bind(fs)
    let calls = 0
    const spy = vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      // The first write has already taken its snapshot (old) when it is held back. Unserialised,
      // the second write would then finish first and the old snapshot would replace it.
      if (calls++ === 0) await new Promise((r) => setTimeout(r, 80))
      return (realWriteFile as (...a: unknown[]) => Promise<void>)(...args)
    })
    try {
      const first = a.set('k', { context: 'old', namespace: null })
      await new Promise((r) => setTimeout(r, 20))
      await Promise.all([first, a.set('k', { context: 'new', namespace: null })])
    } finally {
      spy.mockRestore()
    }
    const b = new KubeTargetStore(file())
    await b.load()
    expect(b.get('k')).toEqual({ context: 'new', namespace: null })
  })

  it('a rejected write does not block the next one, which still lands on disk', async () => {
    const a = new KubeTargetStore(file())
    await a.load()
    const realRename = fs.rename.bind(fs)
    let calls = 0
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (calls++ === 0) throw new Error('disk full')
      return realRename(from, to)
    })
    try {
      const first = a.set('k', { context: 'one', namespace: null })
      const second = a.set('k2', { context: 'two', namespace: 'n' })
      await expect(first).rejects.toThrow('disk full')
      await second
    } finally {
      spy.mockRestore()
    }
    const b = new KubeTargetStore(file())
    await b.load()
    expect(b.get('k2')).toEqual({ context: 'two', namespace: 'n' })
  })

  it('inherited Object.prototype names are not entries', async () => {
    const a = new KubeTargetStore(file())
    await a.load()
    expect(a.get('constructor')).toBeUndefined()
    expect(a.get('toString')).toBeUndefined()
    expect(a.getOverlay('hasOwnProperty')).toBeUndefined()
  })

  it('a __proto__ key is an ordinary entry and round-trips', async () => {
    const a = new KubeTargetStore(file())
    await a.load()
    await a.set('__proto__', { context: 'p', namespace: null })
    await a.setOverlay('__proto__', 'ov')
    expect(a.get('__proto__')).toEqual({ context: 'p', namespace: null })
    expect(a.get('other')).toBeUndefined()
    const b = new KubeTargetStore(file())
    await b.load()
    expect(b.get('__proto__')).toEqual({ context: 'p', namespace: null })
    expect(b.getOverlay('__proto__')).toBe('ov')
    expect(b.get('context')).toBeUndefined()
  })

  it('a hand-edited file with a __proto__ key loads it as an ordinary entry', async () => {
    await fs.writeFile(
      file(),
      '{"targets":{"__proto__":{"context":"c","namespace":null}},"overlays":{"__proto__":"o"}}',
      'utf8'
    )
    const store = new KubeTargetStore(file())
    expect(await store.load()).toEqual({ recovered: false })
    expect(store.get('__proto__')).toEqual({ context: 'c', namespace: null })
    expect(store.getOverlay('__proto__')).toBe('o')
    expect(store.get('context')).toBeUndefined()
    expect(({} as Record<string, unknown>).context).toBeUndefined()
  })
})

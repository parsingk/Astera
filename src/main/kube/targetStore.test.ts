import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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

  it('two quick set calls leave the newer value on disk', async () => {
    const a = new KubeTargetStore(file())
    await a.load()
    await Promise.all([
      a.set('k', { context: 'old', namespace: null }),
      a.set('k', { context: 'new', namespace: null })
    ])
    const b = new KubeTargetStore(file())
    await b.load()
    expect(b.get('k')).toEqual({ context: 'new', namespace: null })
  })
})

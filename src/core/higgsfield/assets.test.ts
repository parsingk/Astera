import { describe, it, expect, beforeEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { downloadAsset, firstMediaUrl, foreignIds, readLedger, recordAfter, writeLedger } from './assets'

const U = '11111111-1111-4111-8111-111111111111'
const J = '22222222-2222-4222-8222-222222222222'
const ledger = { uploads: { [U]: { account: 'a', path: 'C:/x.png' } }, jobs: { [J]: { account: 'a' } } }

describe('assets', () => {
  it('finds ids from another account in both flag forms and repeated flags', () => {
    const args = ['generate', 'create', 'k', '--image-references', U, '--image-references', 'C:/y.png', `--start-image=${J}`]
    expect(foreignIds(args, ledger, 'b')).toEqual([
      { index: 4, id: U, prefix: '' },
      { index: 7, id: J, prefix: '--start-image=' }
    ])
  })

  it('leaves ids of the same account and unknown ids alone', () => {
    expect(foreignIds(['generate', 'create', 'k', '--image', U], ledger, 'a')).toEqual([])
    expect(foreignIds(['generate', 'create', 'k', '--image', '33333333-3333-4333-8333-333333333333'], ledger, 'b')).toEqual([])
  })

  it('ignores the same uuid outside a media flag', () => {
    expect(foreignIds(['generate', 'create', 'k', '--prompt', U], ledger, 'b')).toEqual([])
  })

  it('picks the first media url from a job', () => {
    expect(firstMediaUrl('{"result":{"url":"https://cdn.x/a.mp4?sig=1"},"thumb":"https://cdn.x/t.jpg"}')).toBe('https://cdn.x/a.mp4?sig=1')
    expect(firstMediaUrl('{"status":"failed"}')).toBeNull()
  })

  it('keeps & in the query of a media url', () => {
    expect(firstMediaUrl('{"url":"https://cdn.x/a.png?sig=1&exp=2&x=y"}')).toBe('https://cdn.x/a.png?sig=1&exp=2&x=y')
  })

  it('does not break on JSON-escaped slashes', () => {
    const m = firstMediaUrl('{"url":"https:\/\/cdn.x\/a.mp4?s=1"}')
    expect(m).toBe('https://cdn.x/a.mp4?s=1')
  })

  it('decodes \u0026 as Go writes it in JSON', () => {
    expect(firstMediaUrl(String.raw`{"url":"https://cdn.x/a.mp4?x=1\u0026sig=2"}`)).toBe('https://cdn.x/a.mp4?x=1&sig=2')
    expect(firstMediaUrl(String.raw`{"url":"https:\/\/cdn.x\/a.mp4?x=1\u0026sig=2"}`)).toBe('https://cdn.x/a.mp4?x=1&sig=2')
    expect(firstMediaUrl(String.raw`not json "https://cdn.x/a.mp4?x=1\u0026sig=2"`)).toBe('https://cdn.x/a.mp4?x=1&sig=2')
  })

  it('keeps a download extension only when it is a plain one', async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-hfd-'))
    const f = async () => new Response(new Uint8Array([1]))
    expect(path.extname(await downloadAsset(profile, 'j1', 'https://cdn.x/a.mp4', f))).toBe('.mp4')
    expect(path.extname(await downloadAsset(profile, 'j2', 'https://cdn.x/a.mp4:x', f))).toBe('.bin')
    expect(path.extname(await downloadAsset(profile, 'j3', 'https://cdn.x/a.waytoolongext1', f))).toBe('.bin')
  })

  it('gives up on a download that does not answer in time, leaving no file', async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-hfd-'))
    const hang = ((_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
      init?.signal?.addEventListener('abort', () => rej(init.signal!.reason))
    })) as unknown as typeof fetch
    await expect(downloadAsset(profile, 'j1', 'https://cdn.x/a.mp4', hang, { timeoutMs: 50 })).rejects.toThrow()
    expect(await fs.readdir(path.join(profile, 'higgsfield', 'assets'))).toEqual([])
  }, 5000)
})

describe('recordAfter / readLedger', () => {
  let profile: string
  beforeEach(async () => { profile = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-hfa-')) })

  it('reads an empty ledger when the file is missing or bad', async () => {
    expect(await readLedger(profile)).toEqual({ uploads: {}, jobs: {} })
    await fs.mkdir(path.join(profile, 'higgsfield'), { recursive: true })
    await fs.writeFile(path.join(profile, 'higgsfield', 'assets.json'), '{nope')
    expect(await readLedger(profile)).toEqual({ uploads: {}, jobs: {} })
  })

  it('records an upload with its absolute path, also after global flags', async () => {
    await recordAfter(profile, 'a', ['--json', 'upload', 'create', 'img.png'], JSON.stringify({ id: U.toUpperCase() }))
    expect(await readLedger(profile)).toEqual({ uploads: { [U]: { account: 'a', path: path.resolve('img.png') } }, jobs: {} })
  })

  it('records jobs for generate create and workflow, without overwriting', async () => {
    await recordAfter(profile, 'a', ['--json', 'generate', 'create', 'k'], `{"id":"${J}"}`)
    await recordAfter(profile, 'b', ['generate', 'workflow', 'w'], `{"id":"${J}"}`)
    expect((await readLedger(profile)).jobs[J]).toEqual({ account: 'a' })
  })

  it('records nothing for other commands', async () => {
    await recordAfter(profile, 'a', ['model', 'list'], `{"id":"${J}"}`)
    await expect(fs.stat(path.join(profile, 'higgsfield', 'assets.json'))).rejects.toThrow()
  })
})

// Audit U-8: a ledger the read could not open was taken for an empty one, and the next record wrote a ledger of a few new
// ids over every id it held.
describe('recordAfter with a ledger it could not read', () => {
  it('records nothing rather than writing over it', async () => {
    const A = '11111111-1111-4111-8111-111111111111'
    const B = '22222222-2222-4222-8222-222222222222'
    const prof = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-hfl-'))
    await writeLedger(prof, { uploads: { [A]: { account: 'a1', path: 'C:/x.png' } }, jobs: {} })
    const real = fs.readFile.bind(fs)
    vi.spyOn(fs, 'readFile').mockImplementation(((p: unknown, ...rest: unknown[]) =>
      String(p).endsWith('assets.json') ? Promise.reject(Object.assign(new Error('busy'), { code: 'EBUSY' })) : (real as (...a: unknown[]) => Promise<unknown>)(p, ...rest)) as typeof fs.readFile)
    await recordAfter(prof, 'a2', ['generate', 'create', 'x'], B)
    vi.restoreAllMocks()
    const l = await readLedger(prof)
    expect(Object.keys(l.uploads)).toEqual([A])
  })
})

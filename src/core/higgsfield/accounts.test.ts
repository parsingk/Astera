import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  addHfAccount, hfAccountDir, hfEnvFor, importHfAccount, patchHfAccount, readHfAccounts, removeHfAccount,
  resolveHfAccount, setHfCurrent, writeHfAccounts
} from './accounts'

let profile: string
beforeEach(async () => {
  profile = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-hf-acc-'))
})

describe('higgsfield accounts store', () => {
  it('reads a missing file as no accounts', async () => {
    expect(await readHfAccounts(profile)).toEqual({ accounts: [], current: null })
  })

  it('throws on a malformed file rather than reading it as empty', async () => {
    await fs.mkdir(path.join(profile, 'higgsfield'), { recursive: true })
    await fs.writeFile(path.join(profile, 'higgsfield', 'accounts.json'), '{nope')
    await expect(readHfAccounts(profile)).rejects.toThrow()
  })

  it('makes the first account current and keeps current on the second', async () => {
    const a = await addHfAccount(profile, 'A')
    const b = await addHfAccount(profile, 'B')
    const f = await readHfAccounts(profile)
    expect(f.current).toBe(a.id)
    expect(f.accounts.map((x) => x.id)).toEqual([a.id, b.id])
    expect((await fs.stat(hfAccountDir(profile, b.id))).isDirectory()).toBe(true)
  })

  it('imports by copying, leaving the source in place', async () => {
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-hf-src-'))
    await fs.writeFile(path.join(src, 'credentials.json'), '{"access_token":"x"}')
    await fs.writeFile(path.join(src, 'config.json'), '{}')
    const a = await importHfAccount(profile, 'Main', src)
    expect(await fs.readFile(path.join(hfAccountDir(profile, a.id), 'credentials.json'), 'utf8')).toBe('{"access_token":"x"}')
    expect(await fs.readFile(path.join(src, 'credentials.json'), 'utf8')).toBe('{"access_token":"x"}')
  })

  it('refuses an import with no credentials file', async () => {
    const src = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-hf-src-'))
    await expect(importHfAccount(profile, 'Main', src)).rejects.toThrow(/credentials\.json/)
    expect((await readHfAccounts(profile)).accounts).toEqual([])
  })

  it('resolves by id, label or email, and reports a shared label as ambiguous', () => {
    const f = { accounts: [{ id: 'a1', label: 'Work', email: 'w@x.com' }, { id: 'b2', label: 'work' }], current: 'a1' }
    expect(resolveHfAccount(f, 'b2')).toEqual(f.accounts[1])
    expect(resolveHfAccount(f, 'W@X.COM')).toEqual(f.accounts[0])
    expect(resolveHfAccount(f, 'WORK')).toBe('ambiguous')
    expect(resolveHfAccount(f, 'none')).toBeUndefined()
  })

  it('leaves no current account after removing the current one (D2: never picks for the person)', async () => {
    const a = await addHfAccount(profile, 'A')
    await addHfAccount(profile, 'B')
    await removeHfAccount(profile, a.id)
    expect((await readHfAccounts(profile)).current).toBeNull()
    await expect(fs.stat(hfAccountDir(profile, a.id))).rejects.toThrow()
  })

  it('refuses setCurrent for an unknown id', async () => {
    await addHfAccount(profile, 'A')
    await expect(setHfCurrent(profile, 'zz')).rejects.toThrow(/unknown/)
  })

  it('points the env at the account folder', () => {
    const env = hfEnvFor(profile, 'a1')
    expect(env.HIGGSFIELD_CREDENTIALS_PATH).toBe(path.join(profile, 'higgsfield', 'a1', 'credentials.json'))
    expect(env.HIGGSFIELD_CONFIG_PATH).toBe(path.join(profile, 'higgsfield', 'a1', 'config.json'))
  })

  it('writes atomically (no tmp file left)', async () => {
    await writeHfAccounts(profile, { accounts: [], current: null })
    expect(await fs.readdir(path.join(profile, 'higgsfield'))).toEqual(['accounts.json'])
  })
})

describe('removeHfAccount guard', () => {
  it('keeps current when another account is removed', async () => {
    const a = await addHfAccount(profile, 'A')
    const b = await addHfAccount(profile, 'B')
    await removeHfAccount(profile, b.id)
    expect((await readHfAccounts(profile)).current).toBe(a.id)
  })

  it('refuses an id that is not in the file before deleting anything', async () => {
    const a = await addHfAccount(profile, 'A')
    const sentinel = path.join(profile, 'higgsfield', 'keep.txt')
    await fs.writeFile(sentinel, 'x')
    for (const bad of ['..', '', '.', 'nope']) {
      await expect(removeHfAccount(profile, bad)).rejects.toThrow(/unknown higgsfield account/)
    }
    expect(await fs.readFile(sentinel, 'utf8')).toBe('x')
    expect((await readHfAccounts(profile)).accounts.map((x) => x.id)).toEqual([a.id])
  })
})

// Audit U-8 (ruling reversed): the app, the CLI and hf-proxy change accounts.json from different processes; each read
// it and wrote it whole, so a change made meanwhile was lost. Every change now reads and writes under one lock.
describe('account changes made at the same time', () => {
  it('keeps two patches to two accounts', async () => {
    const a = await addHfAccount(profile, 'A')
    const b = await addHfAccount(profile, 'B')
    await Promise.all([patchHfAccount(profile, a.id, { email: 'a@x' }), patchHfAccount(profile, b.id, { needsLogin: true })])
    const f = await readHfAccounts(profile)
    expect(f.accounts.find((x) => x.id === a.id)?.email).toBe('a@x')
    expect(f.accounts.find((x) => x.id === b.id)?.needsLogin).toBe(true)
  })
  it('keeps a patch and a change of the current account', async () => {
    const a = await addHfAccount(profile, 'A')
    const b = await addHfAccount(profile, 'B')
    await Promise.all([setHfCurrent(profile, b.id), patchHfAccount(profile, a.id, { email: 'a@x' })])
    const f = await readHfAccounts(profile)
    expect(f.current).toBe(b.id)
    expect(f.accounts.find((x) => x.id === a.id)?.email).toBe('a@x')
  })
  it('keeps both of two accounts added together', async () => {
    await Promise.all([addHfAccount(profile, 'A'), addHfAccount(profile, 'B')])
    expect((await readHfAccounts(profile)).accounts.map((x) => x.label).sort()).toEqual(['A', 'B'])
  })
  it('keeps an account added while another is removed', async () => {
    const a = await addHfAccount(profile, 'A')
    await Promise.all([removeHfAccount(profile, a.id), addHfAccount(profile, 'B')])
    expect((await readHfAccounts(profile)).accounts.map((x) => x.label)).toEqual(['B'])
  })
})

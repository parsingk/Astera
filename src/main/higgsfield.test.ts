import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { higgsfieldHandlers } from './higgsfield'
import { hfEnvFor, patchHfAccount, readHfAccounts } from '../core/higgsfield/accounts'

let profile: string, home: string
beforeEach(async () => {
  profile = await fs.mkdtemp(path.join(os.tmpdir(), 'hfm-p-'))
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'hfm-h-'))
})
// runLogin stands in for the real CLI: like it, it leaves a credentials file in the account's folder.
const loginOk = (profileDir: string) => async (id: string) => {
  await fs.writeFile(hfEnvFor(profileDir, id).HIGGSFIELD_CREDENTIALS_PATH, '{"token":"t"}')
  return 0
}
const h = (over = {}) =>
  higgsfieldHandlers({
    profileDir: profile, home, cliFound: () => true,
    runStatus: async () => ({ email: 'a@x.com', credits: 5 }), runLogin: loginOk(profile), ...over
  })

describe('higgsfield main handlers', () => {
  it('imports the login outside Astera by copy', async () => {
    const src = path.join(home, '.config', 'higgsfield')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(path.join(src, 'credentials.json'), '{"a":1}')
    const { id } = await h().importCurrent('Main')
    expect((await readHfAccounts(profile)).accounts[0]).toMatchObject({ id, label: 'Main' })
    expect(await fs.readFile(path.join(src, 'credentials.json'), 'utf8')).toBe('{"a":1}')
  })
  it('refuses an import when nothing is logged in', async () => {
    await expect(h().importCurrent('Main')).rejects.toThrow(/credentials\.json/)
  })
  it('clears "log in again" after a successful login and records the email', async () => {
    const { id } = await h().add('A')
    await patchHfAccount(profile, id, { needsLogin: true })
    expect((await h().login(id)).ok).toBe(true)
    const a = (await readHfAccounts(profile)).accounts[0]
    expect(a.needsLogin).toBeUndefined()
    expect(a.email).toBe('a@x.com')
    await expect(fs.stat(hfEnvFor(profile, id).HIGGSFIELD_CREDENTIALS_PATH + '.bak')).resolves.toBeTruthy()
  })
  it('reports the CLI error line when login fails and keeps needsLogin', async () => {
    const { id } = await h().add('A')
    await patchHfAccount(profile, id, { needsLogin: true })
    const r = await h({ runLogin: async () => ({ code: 1, lastError: 'denied' }) }).login(id)
    expect(r).toEqual({ ok: false, message: 'denied' })
    expect((await readHfAccounts(profile)).accounts[0].needsLogin).toBe(true)
  })
  it('does not call exit 0 without a credentials file a success', async () => {
    const { id } = await h().add('A')
    expect((await h({ runLogin: async () => 0 }).login(id)).ok).toBe(false)
  })
  it('rejects setCurrent and remove for an unknown id', async () => {
    await h().add('A')
    await expect(h().setCurrent('zzz')).rejects.toThrow(/unknown higgsfield account/)
    await expect(h().remove('zzz')).rejects.toThrow(/unknown higgsfield account/)
  })
  it('refuses input that is not a plain id or a non-empty label', async () => {
    await expect(h().add('')).rejects.toThrow(/INVALID/)
    await expect(h().add('   ')).rejects.toThrow(/INVALID/)
    await expect(h().remove('..')).rejects.toThrow(/INVALID/)
    await expect(h().remove('')).rejects.toThrow(/INVALID/)
    await expect(h().login('a/b')).rejects.toThrow(/INVALID/)
    await expect(h().setCurrent(5 as unknown as string)).rejects.toThrow(/INVALID/)
  })
  it('lists accounts with credits, the current one, and whether a CLI was found', async () => {
    const { id } = await h().add('A')
    const l = await h({ cliFound: () => false }).list()
    expect(l).toMatchObject({ current: id, cliFound: false, accounts: [{ id, label: 'A', email: 'a@x.com', credits: 5, current: true, needsLogin: false }] })
  })
  it('removes an account and its folder', async () => {
    const { id } = await h().add('A')
    await h().remove(id)
    expect((await readHfAccounts(profile)).accounts).toEqual([])
    await expect(fs.stat(path.join(profile, 'higgsfield', id))).rejects.toThrow()
  })
})

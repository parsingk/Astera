import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { higgsfieldCommand, statusRun } from './higgsfield'
import { addHfAccount, hfAccountDir, patchHfAccount, readHfAccounts } from '../core/higgsfield/accounts'
import type { HfRunner } from './hfProxy'

let profile: string
beforeEach(async () => { profile = await fs.mkdtemp(path.join(os.tmpdir(), 'hfc-')) })
const run = async (id: string) => ({ email: `${id}@x.com`, credits: 10 })

describe('astera higgsfield', () => {
  it('lists accounts with credits and the current one', async () => {
    const a = await addHfAccount(profile, 'A'); await addHfAccount(profile, 'B')
    const r = await higgsfieldCommand({ cmd: 'higgsfield-list', args: {}, profileDir: profile, run })
    expect(r.ok && r.body.current).toBe(a.id)
    expect(r.ok && (r.body.accounts as any[]).map((x) => [x.label, x.credits, x.current])).toEqual([['A', 10, true], ['B', 10, false]])
  })

  it('asks for the accounts one at a time, skips needsLogin, and keeps the email it saw', async () => {
    await addHfAccount(profile, 'A'); const b = await addHfAccount(profile, 'B'); const c = await addHfAccount(profile, 'C')
    await patchHfAccount(profile, b.id, { needsLogin: true })
    let active = 0; let peak = 0; const asked: string[] = []
    const slow = async (id: string) => {
      asked.push(id); active++; peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5)); active--
      return { email: `${id}@x.com`, credits: 3 }
    }
    const r = await higgsfieldCommand({ cmd: 'higgsfield-list', args: {}, profileDir: profile, run: slow })
    expect(peak).toBe(1)
    expect(asked).not.toContain(b.id)
    const rows = r.ok ? (r.body.accounts as any[]) : []
    expect(rows.find((x) => x.id === b.id)).toMatchObject({ credits: null, needsLogin: true })
    expect((await readHfAccounts(profile)).accounts.find((x) => x.id === c.id)?.email).toBe(`${c.id}@x.com`)
  })

  it('switches by label', async () => {
    await addHfAccount(profile, 'A'); const b = await addHfAccount(profile, 'B')
    const r = await higgsfieldCommand({ cmd: 'higgsfield-use', args: { account: 'b' }, profileDir: profile, run })
    expect(r.ok).toBe(true)
    expect(r.ok && r.body.current).toMatchObject({ id: b.id, label: 'B', credits: 10 })
    expect((await readHfAccounts(profile)).current).toBe(b.id)
  })

  it('refuses an account that has to log in again', async () => {
    await addHfAccount(profile, 'A'); const b = await addHfAccount(profile, 'B')
    await patchHfAccount(profile, b.id, { needsLogin: true })
    const r = await higgsfieldCommand({ cmd: 'higgsfield-use', args: { account: b.id }, profileDir: profile, run })
    expect(!r.ok && r.error.code).toBe('CONFLICT')
  })

  it('refuses use without --account, an unknown one, and an ambiguous one', async () => {
    await addHfAccount(profile, 'A'); await addHfAccount(profile, 'a')
    const r1 = await higgsfieldCommand({ cmd: 'higgsfield-use', args: {}, profileDir: profile, run })
    expect(!r1.ok && r1.error.code).toBe('INVALID_ARGUMENTS')
    const r2 = await higgsfieldCommand({ cmd: 'higgsfield-use', args: { account: 'zz' }, profileDir: profile, run })
    expect(!r2.ok && r2.error.code).toBe('NOT_FOUND')
    const r3 = await higgsfieldCommand({ cmd: 'higgsfield-use', args: { account: 'a' }, profileDir: profile, run })
    expect(!r3.ok && r3.error.code).toBe('INVALID_ARGUMENTS')
  })
})

describe('statusRun (the default account status call)', () => {
  it('reads email and credits, and puts back credentials the CLI deleted', async () => {
    const a = await addHfAccount(profile, 'A')
    const creds = path.join(hfAccountDir(profile, a.id), 'credentials.json')
    await fs.writeFile(creds, '{"token":"t"}'); await fs.writeFile(`${creds}.bak`, '{"token":"t"}')
    let calls = 0
    const cli: HfRunner = async (_args, env) => {
      calls++
      expect(env.HIGGSFIELD_CREDENTIALS_PATH).toBe(creds)
      if (calls === 1) { await fs.rm(creds); return { code: 1, stdout: '', stderr: 'refresh failed' } }
      return { code: 0, stdout: '{"email":"a@x.com","credits":7}', stderr: '' }
    }
    const first = await statusRun(profile, {}, cli)(a.id)
    expect(first).toBeNull()
    await expect(fs.stat(creds)).resolves.toBeTruthy()
    const second = await statusRun(profile, {}, cli)(a.id)
    expect(second).toEqual({ email: 'a@x.com', credits: 7 })
  })
})

describe('statusRun: what a failed status call means', () => {
  const withLogin = async (label: string) => {
    const a = await addHfAccount(profile, label)
    const creds = path.join(hfAccountDir(profile, a.id), 'credentials.json')
    await fs.writeFile(creds, '{"token":"t"}'); await fs.writeFile(`${creds}.bak`, '{"token":"t"}')
    return { a, creds }
  }
  it('marks an account whose server session expired "log in again", and use refuses it', async () => {
    const { a, creds } = await withLogin('A')
    const cli: HfRunner = async () => ({ code: 2, stdout: '', stderr: 'Error: Session expired.\nHint: Run: hf auth login\n' })
    expect(await statusRun(profile, {}, cli)(a.id)).toEqual({ credits: null, needsLogin: true })
    expect((await readHfAccounts(profile)).accounts[0].needsLogin).toBe(true)
    expect(await fs.readFile(creds, 'utf8')).toBe('{"token":"t"}')
    const r = await higgsfieldCommand({ cmd: 'higgsfield-use', args: { account: 'A' }, profileDir: profile, run })
    expect(!r.ok && r.error.code).toBe('CONFLICT')
  })
  it('does not mark an account for a failure that is not an expired session', async () => {
    const { a } = await withLogin('A')
    const cli: HfRunner = async () => ({ code: 1, stdout: '', stderr: 'network unreachable' })
    expect(await statusRun(profile, {}, cli)(a.id)).toBeNull()
    expect((await readHfAccounts(profile)).accounts[0].needsLogin).toBeUndefined()
  })
  it('reports a missing CLI program without marking the account or touching its backup', async () => {
    const { a, creds } = await withLogin('A')
    await fs.writeFile(`${creds}.bak`, '{"old":1}')
    const cli: HfRunner = async () => ({ code: 1, stdout: '', stderr: '@higgsfield/cli: binary not found at /n/@higgsfield/cli/vendor/hf. Reinstall: npm i -g @higgsfield/cli\n' })
    expect(await statusRun(profile, {}, cli)(a.id)).toEqual({ credits: null, binaryMissing: '/n/@higgsfield/cli/vendor/hf' })
    expect((await readHfAccounts(profile)).accounts[0].needsLogin).toBeUndefined()
    expect(await fs.readFile(`${creds}.bak`, 'utf8')).toBe('{"old":1}')
  })
})

describe('astera higgsfield list: status answers', () => {
  it('shows an account the status call found expired as "log in again"', async () => {
    const a = await addHfAccount(profile, 'A')
    const r = await higgsfieldCommand({ cmd: 'higgsfield-list', args: {}, profileDir: profile,
      run: async () => { await patchHfAccount(profile, a.id, { needsLogin: true }); return { credits: null, needsLogin: true } } })
    expect(r.ok && (r.body.accounts as any[])[0]).toMatchObject({ credits: null, needsLogin: true })
  })
  it('stops asking once the CLI program is missing and says so', async () => {
    await addHfAccount(profile, 'A'); await addHfAccount(profile, 'B')
    const asked: string[] = []
    const r = await higgsfieldCommand({ cmd: 'higgsfield-list', args: {}, profileDir: profile,
      run: async (id) => { asked.push(id); return { credits: null, binaryMissing: '/v/hf' } } })
    expect(asked.length).toBe(1)
    expect(r.ok && r.body.cliIssue).toEqual({ kind: 'binaryMissing', path: '/v/hf' })
    expect(r.ok && (r.body.accounts as any[]).map((x) => x.credits)).toEqual([null, null])
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { higgsfieldHandlers, LOGIN_TIMEOUT_MS, loginUrlReader, type LoginIo } from './higgsfield'
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

describe('higgsfield main handlers: no overlapping real-CLI work', () => {
  const tracker = () => {
    let now = 0, peak = 0, calls = 0
    const enter = async (): Promise<void> => { now++; calls++; peak = Math.max(peak, now); await new Promise((r) => setTimeout(r, 15)); now-- }
    return { enter, peak: () => peak, calls: () => calls }
  }
  it('answers two simultaneous list() calls with one set of status calls', async () => {
    const tr = tracker()
    const hh = h({ runStatus: async () => { await tr.enter(); return { credits: 1 } } })
    await hh.add('A')
    const [x, y] = await Promise.all([hh.list(), hh.list()])
    expect(x).toEqual(y)
    expect(tr.calls()).toBe(1)
  })
  it('never runs list() and login() at the same time', async () => {
    const tr = tracker()
    const hh = h({
      runStatus: async () => { await tr.enter(); return { credits: 1 } },
      runLogin: async (id: string) => { await tr.enter(); return loginOk(profile)(id) }
    })
    const { id } = await hh.add('A')
    await Promise.all([hh.list(), hh.login(id), hh.list()])
    expect(tr.peak()).toBe(1)
  })
  it('keeps going after a handler failed', async () => {
    const hh = h()
    await Promise.allSettled([hh.setCurrent('zzz')])
    await expect(hh.add('B')).resolves.toBeTruthy()
  })
})

describe('importCurrent validates what it copied', () => {
  it('removes the new account and refuses a garbled source login', async () => {
    const src = path.join(home, '.config', 'higgsfield')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(path.join(src, 'credentials.json'), '{"a":')
    await expect(h().importCurrent('Main')).rejects.toThrow(/INVALID: the login file being imported is incomplete/)
    expect((await readHfAccounts(profile)).accounts).toEqual([])
  })
  it('backs up a good import', async () => {
    const src = path.join(home, '.config', 'higgsfield')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(path.join(src, 'credentials.json'), '{"a":1}')
    const { id } = await h().importCurrent('Main')
    await expect(fs.stat(hfEnvFor(profile, id).HIGGSFIELD_CREDENTIALS_PATH + '.bak')).resolves.toBeTruthy()
  })
})

describe('higgsfield login without holding the other handlers', () => {
  const URL = 'https://clerk.higgsfield.ai/oauth/authorize?client_id=c&redirect_uri=http%3A%2F%2Flocalhost%3A8765%2Fcallback'
  /** A login that runs until it is aborted (killed) or released; it reports when it stopped. */
  const heldLogin = () => {
    let release!: (code: number) => void
    let io: LoginIo | undefined
    const ev: string[] = []
    let started!: () => void
    const startedP = new Promise<void>((r) => { started = r })
    const run = async (id: string, given: LoginIo): Promise<number> => {
      io = given
      ev.push(`start ${id}`)
      started()
      const code = await new Promise<number>((resolve) => {
        release = resolve
        given.signal.addEventListener('abort', () => { ev.push('killed'); setTimeout(() => { ev.push('exited'); resolve(1) }, 20) })
      })
      if (code === 0) await fs.writeFile(hfEnvFor(profile, id).HIGGSFIELD_CREDENTIALS_PATH, '{"token":"t"}')
      return code
    }
    return { run, ev, started: () => startedP, release: (c: number) => release(c), io: () => io! }
  }

  it('cancel kills the login process and resolves after it exited; login() resolves cancelled', async () => {
    const hl = heldLogin()
    const hh = h({ runLogin: hl.run })
    const { id } = await hh.add('A')
    const p = hh.login(id)
    await hl.started()
    expect(await hh.loginState()).toEqual({ id, url: null })
    await hh.cancelLogin()
    expect(hl.ev).toEqual([`start ${id}`, 'killed', 'exited'])
    expect(await p).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(await hh.loginState()).toBeNull()
    await expect(hh.cancelLogin()).resolves.toBeUndefined()   // nothing to cancel
  })

  it('times out: kills the process and says so', async () => {
    const hl = heldLogin()
    const hh = h({ runLogin: hl.run, loginTimeoutMs: 30 })
    const { id } = await hh.add('A')
    expect(await hh.login(id)).toMatchObject({ ok: false, reason: 'timeout' })
    expect(hl.ev).toContain('killed')
    expect(await hh.loginState()).toBeNull()
  })

  it('waits three minutes by default', async () => {
    expect(LOGIN_TIMEOUT_MS).toBe(3 * 60_000)
  })

  it('reads the URL from the complete "visit:" line, even when it arrives in pieces', async () => {
    const hl = heldLogin()
    const hh = h({ runLogin: hl.run })
    const { id } = await hh.add('A')
    const p = hh.login(id)
    await hl.started()
    hl.io().onStdout('Opening browser for authentication...\nIf browser does not open, visit: ' + URL.slice(0, 40))
    expect((await hh.loginState())?.url).toBeNull()
    hl.io().onStdout(URL.slice(40) + '\r\nWaiting for approval...\n')
    expect(await hh.loginState()).toEqual({ id, url: URL })
    hl.release(0)
    expect(await p).toEqual({ ok: true })
  })

  it('leaves the logging-in account out of list() status calls and shows it as logging in', async () => {
    const hl = heldLogin()
    const asked: string[] = []
    const hh = h({ runLogin: hl.run, runStatus: async (x: string) => { asked.push(x); return { credits: 9 } } })
    const { id: a } = await hh.add('A')
    const { id: b } = await hh.add('B')
    const p = hh.login(a)
    await hl.started()
    const l = await hh.list()
    expect(asked).toEqual([b])
    expect(l.accounts.find((x) => x.id === a)).toMatchObject({ loggingIn: true, credits: null })
    expect(l.accounts.find((x) => x.id === b)).toMatchObject({ loggingIn: false, credits: 9 })
    await hh.cancelLogin(); await p
  })

  it('keeps the other handlers working during a login, and refuses remove/login on that account', async () => {
    const hl = heldLogin()
    const hh = h({ runLogin: hl.run })
    const { id: a } = await hh.add('A')
    const { id: b } = await hh.add('B')
    const p = hh.login(a)
    await hl.started()
    const src = path.join(home, '.config', 'higgsfield')
    await fs.mkdir(src, { recursive: true })
    await fs.writeFile(path.join(src, 'credentials.json'), '{"a":1}')
    await expect(hh.list()).resolves.toBeTruthy()
    await expect(hh.setCurrent(b)).resolves.toBeUndefined()
    const { id: c } = await hh.add('C')
    await expect(hh.importCurrent('D')).resolves.toBeTruthy()
    await expect(hh.remove(c)).resolves.toBeUndefined()
    await expect(hh.remove(a)).rejects.toThrow(/BUSY/)
    await expect(hh.login(a)).rejects.toThrow(/BUSY/)
    await expect(hh.login(b)).rejects.toThrow(/BUSY/)           // at most one login at a time
    expect(hl.ev).toEqual([`start ${a}`])                        // still waiting: nothing above waited for it
    hl.release(0)
    expect(await p).toEqual({ ok: true })
    expect((await readHfAccounts(profile)).accounts.map((x) => x.id)).toContain(a)
  })

  it('never runs two real-CLI calls on one account at once', async () => {
    const now = new Map<string, number>(); let peak = 0
    const enter = async (id: string, ms: number) => {
      now.set(id, (now.get(id) ?? 0) + 1); peak = Math.max(peak, now.get(id)!)
      await new Promise((r) => setTimeout(r, ms))
      now.set(id, now.get(id)! - 1)
    }
    const hh = h({
      runStatus: async (x: string) => { await enter(x, 25); return { credits: 1 } },
      runLogin: async (x: string) => { await enter(x, 25); return loginOk(profile)(x) }
    })
    const { id: a } = await hh.add('A')
    await hh.add('B')
    // a list is asking A when the login of A starts; more lists come while it logs in
    const first = hh.list()
    await new Promise((r) => setTimeout(r, 5))
    const p = hh.login(a)
    await Promise.all([first, p, hh.list(), new Promise((r) => setTimeout(r, 10)).then(() => hh.list())])
    expect(peak).toBe(1)
  })

  it('makes no status call while the CLI program is missing and reports it', async () => {
    const asked: string[] = []
    const hh = h({ cliIssue: () => ({ kind: 'binaryMissing', path: '/w/hf.exe' }), runStatus: async (x: string) => { asked.push(x); return { credits: 1 } } })
    await hh.add('A')
    const l = await hh.list()
    expect(asked).toEqual([])
    expect(l.cliIssue).toEqual({ kind: 'binaryMissing', path: '/w/hf.exe' })
    expect(l.accounts[0].credits).toBeNull()
  })

  it('reports a missing program a status call found, and none otherwise', async () => {
    const hh = h({ runStatus: async () => ({ credits: null, binaryMissing: '/v/hf' }) })
    await hh.add('A')
    expect((await hh.list()).cliIssue).toEqual({ kind: 'binaryMissing', path: '/v/hf' })
    expect((await h().list()).cliIssue).toBeNull()
  })
})

describe('loginUrlReader', () => {
  it('takes the first visit: URL on a complete line only', () => {
    const r = loginUrlReader()
    expect(r('visit: https://a.example/x')).toBeNull()
    expect(r('?y=1\n')).toBe('https://a.example/x?y=1')
    expect(r('visit: https://b.example/\n')).toBe('https://a.example/x?y=1')
  })
})

describe('higgsfield workspaces', () => {
  const ws = (id: string, selected = false) => ({ id, name: null, plan_type: 'pro', credits: 5, is_selected: selected, user_role: 'owner' })
  const A1 = 'aaaaaaaa-1111-4111-8111-111111111111'
  const A2 = 'bbbbbbbb-2222-4222-8222-222222222222'
  /** A fake guarded CLI under one account: answers workspace list from `list`, records every call. */
  const cli = (list: unknown[], log: string[][], setCode = 0) => async (id: string, args: string[]) => {
    log.push([id, ...args])
    if (args.join(' ') === 'workspace list --json') return { code: 0, stdout: JSON.stringify(list), stderr: '' }
    if (args[0] === 'workspace' && args[1] === 'set') return { code: setCode, stdout: setCode === 0 ? `Selected workspace: ${args[2]}` : '', stderr: setCode === 0 ? '' : 'Error: not a member\n' }
    return { code: 1, stdout: '', stderr: 'unexpected' }
  }

  it('selects the only workspace after a login', async () => {
    const log: string[][] = []
    const hh = h({ runCli: cli([ws(A1)], log) })
    const { id } = await hh.add('A')
    expect((await hh.login(id)).ok).toBe(true)
    expect(log).toEqual([[id, 'workspace', 'list', '--json'], [id, 'workspace', 'set', A1]])
  })

  it('leaves several workspaces, or one already selected, as they are', async () => {
    for (const list of [[ws(A1), ws(A2)], [ws(A1, true)]]) {
      const log: string[][] = []
      const hh = h({ runCli: cli(list, log) })
      const { id } = await hh.add('A')
      expect((await hh.login(id)).ok).toBe(true)
      expect(log).toEqual([[id, 'workspace', 'list', '--json']])
    }
  })

  it('lists a row that needs a workspace with its workspaces', async () => {
    const rows = [{ id: A1, name: null, plan: 'pro', credits: 5 }, { id: A2, name: 'Team', plan: null, credits: null }]
    const hh = h({ runStatus: async () => ({ credits: null, needsWorkspace: true as const, workspaces: rows }) })
    await hh.add('A')
    expect((await hh.list()).accounts[0]).toMatchObject({ needsWorkspace: true, needsLogin: false, workspaces: rows })
  })

  it('setWorkspace runs workspace set under that account', async () => {
    const log: string[][] = []
    const hh = h({ runCli: cli([], log) })
    const { id } = await hh.add('A')
    await expect(hh.setWorkspace(id, A2)).resolves.toBeUndefined()
    expect(log).toEqual([[id, 'workspace', 'set', A2]])
  })

  it('setWorkspace refuses bad ids, an unknown account, and reports the CLI error', async () => {
    const log: string[][] = []
    const hh = h({ runCli: cli([], log, 1) })
    const { id } = await hh.add('A')
    await expect(hh.setWorkspace(id, 'a b')).rejects.toThrow(/INVALID/)
    await expect(hh.setWorkspace(id, '--help')).rejects.toThrow(/INVALID/)
    await expect(hh.setWorkspace(id, 'x'.repeat(65))).rejects.toThrow(/INVALID/)
    await expect(hh.setWorkspace('a/b', A1)).rejects.toThrow(/INVALID/)
    await expect(hh.setWorkspace('zzz', A1)).rejects.toThrow(/unknown higgsfield account/)
    await expect(hh.setWorkspace(id, A1)).rejects.toThrow(/not a member/)
    expect(log).toEqual([[id, 'workspace', 'set', A1]])
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { backupCredentials, hfProxy, realRunner, restoreOnce } from './hfProxy'
import { readLedger } from '../core/higgsfield/assets'
import { addHfAccount, hfAccountDir, patchHfAccount, readHfAccounts } from '../core/higgsfield/accounts'

const FAKE = path.join(__dirname, '__fixtures__', 'fake-hf.mjs')
// node runs the fixture; the runner is the same one production uses, given `node` + script.
const fakeRunner = () => realRunner(process.execPath, process.platform, [FAKE])

let profile: string, logFile: string, msgs: string[]
const env = (extra: Record<string, string> = {}) => ({ ...process.env, ASTERA_PROFILE_DIR: profile, FAKE_HF_LOG: logFile, ...extra })
const calls = async () => (await fs.readFile(logFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l))

beforeEach(async () => {
  profile = await fs.mkdtemp(path.join(os.tmpdir(), 'hfp-'))
  logFile = path.join(profile, 'calls.log')
  msgs = []
})

describe('hfProxy', () => {
  it('passes through unchanged with no current account', async () => {
    const code = await hfProxy({ args: ['model', 'list'], env: env(), platform: process.platform, home: profile, run: fakeRunner(), write: (s) => msgs.push(s) })
    expect(code).toBe(0)
    expect((await calls())[0]).toEqual({ args: ['model', 'list'] })   // creds undefined → key absent in JSON
  })

  it('runs under the current account folder', async () => {
    const a = await addHfAccount(profile, 'A')
    await fs.writeFile(path.join(hfAccountDir(profile, a.id), 'credentials.json'), '{}')
    await hfProxy({ args: ['model', 'list'], env: env(), platform: process.platform, home: profile, run: fakeRunner() })
    expect((await calls())[0].creds).toBe(path.join(hfAccountDir(profile, a.id), 'credentials.json'))
  })

  it('keeps arguments with spaces and quotes intact', async () => {
    await hfProxy({ args: ['x', '--prompt', 'a b "c"'], env: env(), platform: process.platform, home: profile, run: fakeRunner() })
    expect((await calls())[0].args).toEqual(['x', '--prompt', 'a b "c"'])
  })

  it('returns the real exit code', async () => {
    const code = await hfProxy({ args: ['x'], env: env({ FAKE_HF_EXIT: '3' }), platform: process.platform, home: profile, run: fakeRunner() })
    expect(code).toBe(3)
  })

  it('backs up credentials after a call that leaves them in place', async () => {
    const a = await addHfAccount(profile, 'A')
    const creds = path.join(hfAccountDir(profile, a.id), 'credentials.json')
    await fs.writeFile(creds, '{"t":1}')
    await hfProxy({ args: ['x'], env: env(), platform: process.platform, home: profile, run: fakeRunner() })
    expect(await fs.readFile(`${creds}.bak`, 'utf8')).toBe('{"t":1}')
  })

  it('restores the backup once when the CLI deletes the credentials, and reruns', async () => {
    const a = await addHfAccount(profile, 'A')
    const creds = path.join(hfAccountDir(profile, a.id), 'credentials.json')
    await fs.writeFile(creds, '{"t":1}')
    await fs.writeFile(`${creds}.bak`, '{"t":1}')
    // first run deletes; the status check and the rerun keep the file (FAKE_HF_DELETE_CREDS read per process)
    let n = 0
    const base = fakeRunner()
    const run = (args: string[], e: NodeJS.ProcessEnv, tee: boolean) =>
      base(args, n++ === 0 ? { ...e, FAKE_HF_DELETE_CREDS: '1' } : e, tee)
    const code = await hfProxy({ args: ['x'], env: env(), platform: process.platform, home: profile, run, write: (s) => msgs.push(s) })
    expect(code).toBe(0)
    expect((await calls()).map((c) => c.args.slice(0, 2).join(' '))).toEqual(['x', 'account status', 'x'])
    expect(await fs.readFile(creds, 'utf8')).toBe('{"t":1}')
  })

  it('restores the login but never reruns a job that may already exist (no second charge)', async () => {
    const a = await addHfAccount(profile, 'A')
    const creds = path.join(hfAccountDir(profile, a.id), 'credentials.json')
    await fs.writeFile(creds, '{"t":1}')
    await fs.writeFile(`${creds}.bak`, '{"t":1}')
    const base = fakeRunner()
    // the job is created, then the refresh during --wait fails and the CLI deletes the file
    const run = (args: string[], e: NodeJS.ProcessEnv, t: boolean) =>
      base(args, args.includes('create') ? { ...e, FAKE_HF_DELETE_CREDS: '1', FAKE_HF_EXIT: '1' } : e, t)
    const code = await hfProxy({ args: ['--json', 'generate', 'create', 'kling', '--wait'], env: env(), platform: process.platform, home: profile, run, write: (s) => msgs.push(s) })
    expect(code).toBe(1)
    expect((await calls()).filter((c) => c.args.includes('create')).length).toBe(1)
    expect(await fs.readFile(creds, 'utf8')).toBe('{"t":1}')
    expect(msgs.length).toBe(1)
    expect(msgs[0]).toMatch(/login was restored/i)
    expect(msgs[0]).toContain('higgsfield generate get <id>')
    expect((await readHfAccounts(profile)).accounts[0].needsLogin).toBeFalsy()
  })

  it('never reruns an upload create after restoring the login', async () => {
    const a = await addHfAccount(profile, 'A')
    const creds = path.join(hfAccountDir(profile, a.id), 'credentials.json')
    await fs.writeFile(creds, '{"t":1}')
    await fs.writeFile(`${creds}.bak`, '{"t":1}')
    let n = 0
    const base = fakeRunner()
    const run = (args: string[], e: NodeJS.ProcessEnv, tee: boolean) =>
      base(args, n++ === 0 ? { ...e, FAKE_HF_DELETE_CREDS: '1', FAKE_HF_EXIT: '1' } : e, tee)
    const code = await hfProxy({ args: ['upload', 'create', 'pic.png'], env: env(), platform: process.platform, home: profile, run, write: (s) => msgs.push(s) })
    expect(code).toBe(1)
    expect((await calls()).map((c) => c.args.slice(0, 2).join(' '))).toEqual(['upload create', 'account status'])
    expect(await fs.readFile(creds, 'utf8')).toBe('{"t":1}')
    expect(msgs.join('')).toMatch(/login was restored/i)
  })

  it('marks the account "log in again" when the restore does not hold, without looping', async () => {
    const a = await addHfAccount(profile, 'A')
    const creds = path.join(hfAccountDir(profile, a.id), 'credentials.json')
    await fs.writeFile(creds, '{"t":1}')
    await fs.writeFile(`${creds}.bak`, '{"t":1}')
    const code = await hfProxy({ args: ['x'], env: env({ FAKE_HF_DELETE_CREDS: '1', FAKE_HF_EXIT: '2' }), platform: process.platform, home: profile, run: fakeRunner(), write: (s) => msgs.push(s) })
    expect(code).toBe(2)
    expect((await calls()).length).toBe(2)            // the command, then one status check
    expect((await readHfAccounts(profile)).accounts[0].needsLogin).toBe(true)
    expect(msgs.join('')).toMatch(/log in again/i)
  })

  it('creates no job when credits are short, and names the other account', async () => {
    const a = await addHfAccount(profile, 'A'); const b = await addHfAccount(profile, 'B')
    for (const x of [a, b]) await fs.writeFile(path.join(hfAccountDir(profile, x.id), 'credentials.json'), '{}')
    const code = await hfProxy({ args: ['generate', 'create', 'kling', '--prompt', 'p'], env: env({ FAKE_HF_CREDITS: '3', FAKE_HF_COST: '12' }), platform: process.platform, home: profile, run: fakeRunner(), write: (s) => msgs.push(s) })
    expect(code).toBe(75)
    expect((await calls()).some((c) => c.args[1] === 'create')).toBe(false)
    expect(msgs.join('')).toContain('"B"')
    expect(msgs.join('')).toContain('astera higgsfield use --account')
  })

  it('runs the job when the cost cannot be read', async () => {
    const a = await addHfAccount(profile, 'A')
    await fs.writeFile(path.join(hfAccountDir(profile, a.id), 'credentials.json'), '{}')
    const run = fakeRunner()
    const flaky = (args: string[], e: NodeJS.ProcessEnv, t: boolean) => args[1] === 'cost' ? Promise.resolve({ code: 1, stdout: '', stderr: 'net' }) : run(args, e, t)
    const code = await hfProxy({ args: ['generate', 'create', 'kling'], env: env(), platform: process.platform, home: profile, run: flaky })
    expect(code).toBe(0)
    expect((await calls()).some((c) => c.args[1] === 'create')).toBe(true)
  })

  it('runs the job when credits cover the cost', async () => {
    const a = await addHfAccount(profile, 'A')
    await fs.writeFile(path.join(hfAccountDir(profile, a.id), 'credentials.json'), '{}')
    const code = await hfProxy({ args: ['generate', 'create', 'kling'], env: env({ FAKE_HF_CREDITS: '50', FAKE_HF_COST: '12' }), platform: process.platform, home: profile, run: fakeRunner() })
    expect(code).toBe(0)
    expect((await calls()).some((c) => c.args[1] === 'create')).toBe(true)
  })

  it('does not pre-check commands that are not jobs', async () => {
    const a = await addHfAccount(profile, 'A')
    await fs.writeFile(path.join(hfAccountDir(profile, a.id), 'credentials.json'), '{}')
    await hfProxy({ args: ['generate', 'get', 'x'], env: env(), platform: process.platform, home: profile, run: fakeRunner() })
    expect((await calls()).map((c) => c.args.slice(0, 2).join(' '))).toEqual(['generate get'])
  })

  it('leaves another account\'s credentials restored when its status call deletes them', async () => {
    const a = await addHfAccount(profile, 'A'); const b = await addHfAccount(profile, 'B')
    const credsOf = (x: { id: string }) => path.join(hfAccountDir(profile, x.id), 'credentials.json')
    await fs.writeFile(credsOf(a), '{}')
    await fs.writeFile(credsOf(b), '{"t":"b"}')
    await fs.writeFile(`${credsOf(b)}.bak`, '{"t":"b"}')
    const base = fakeRunner()
    // the CLI "fails to refresh" and deletes the file only when it runs under B
    const run = (args: string[], e: NodeJS.ProcessEnv, t: boolean) =>
      base(args, e.HIGGSFIELD_CREDENTIALS_PATH === credsOf(b) ? { ...e, FAKE_HF_DELETE_CREDS: '1' } : e, t)
    const code = await hfProxy({ args: ['generate', 'create', 'kling'], env: env({ FAKE_HF_CREDITS: '3', FAKE_HF_COST: '12' }), platform: process.platform, home: profile, run, write: (s) => msgs.push(s) })
    expect(code).toBe(75)
    expect(await fs.readFile(credsOf(b), 'utf8')).toBe('{"t":"b"}')
    expect(await fs.readFile(credsOf(a), 'utf8')).toBe('{}')
  })

  it('restores the current account\'s credentials when the pre-check deletes them', async () => {
    const a = await addHfAccount(profile, 'A')
    const creds = path.join(hfAccountDir(profile, a.id), 'credentials.json')
    await fs.writeFile(creds, '{"t":1}')
    await fs.writeFile(`${creds}.bak`, '{"t":1}')
    const base = fakeRunner()
    const run = (args: string[], e: NodeJS.ProcessEnv, t: boolean) =>
      base(args, args[1] === 'cost' ? { ...e, FAKE_HF_DELETE_CREDS: '1' } : e, t)
    const code = await hfProxy({ args: ['generate', 'create', 'kling'], env: env(), platform: process.platform, home: profile, run, write: (s) => msgs.push(s) })
    expect(code).toBe(0)
    expect(await fs.readFile(creds, 'utf8')).toBe('{"t":1}')
  })

  it('skips accounts that need a login when listing the others', async () => {
    const a = await addHfAccount(profile, 'A'); const b = await addHfAccount(profile, 'B')
    await fs.writeFile(path.join(hfAccountDir(profile, a.id), 'credentials.json'), '{}')
    await patchHfAccount(profile, b.id, { needsLogin: true })
    const code = await hfProxy({ args: ['generate', 'create', 'kling'], env: env({ FAKE_HF_CREDITS: '3', FAKE_HF_COST: '12' }), platform: process.platform, home: profile, run: fakeRunner(), write: (s) => msgs.push(s) })
    expect(code).toBe(75)
    expect(msgs.join('')).not.toContain('"B"')
    expect(msgs.join('')).toContain('no other account')
  })

  it('tells the agent to ask when the job itself is refused for credits', async () => {
    const a = await addHfAccount(profile, 'A')
    await fs.writeFile(path.join(hfAccountDir(profile, a.id), 'credentials.json'), '{}')
    const base = fakeRunner()
    const run = (args: string[], e: NodeJS.ProcessEnv, t: boolean) =>
      args[1] === 'create' ? Promise.resolve({ code: 1, stdout: '', stderr: 'Error: insufficient credits' }) : base(args, e, t)
    const code = await hfProxy({ args: ['generate', 'create', 'kling'], env: env({ FAKE_HF_CREDITS: '50', FAKE_HF_COST: '5' }), platform: process.platform, home: profile, run, write: (s) => msgs.push(s) })
    expect(code).toBe(1)
    expect(msgs.join('')).toContain('Ask the user which account to use')
  })

  it('runs the pre-check calls one after the other, status first', async () => {
    const a = await addHfAccount(profile, 'A')
    await fs.writeFile(path.join(hfAccountDir(profile, a.id), 'credentials.json'), '{}')
    const base = fakeRunner(); const ev: string[] = []
    const run = async (args: string[], e: NodeJS.ProcessEnv, t: boolean) => {
      const n = args.slice(0, 2).join(' '); ev.push(`start ${n}`)
      const r = await base(args, e, t); ev.push(`end ${n}`); return r
    }
    await hfProxy({ args: ['generate', 'create', 'kling'], env: env(), platform: process.platform, home: profile, run })
    expect(ev.slice(0, 4)).toEqual(['start account status', 'end account status', 'start generate cost', 'end generate cost'])
  })

  it('prices a job given after leading global flags', async () => {
    const a = await addHfAccount(profile, 'A')
    await fs.writeFile(path.join(hfAccountDir(profile, a.id), 'credentials.json'), '{}')
    const code = await hfProxy({ args: ['--json', 'generate', 'create', 'k'], env: env({ FAKE_HF_CREDITS: '3', FAKE_HF_COST: '12' }), platform: process.platform, home: profile, run: fakeRunner(), write: (s) => msgs.push(s) })
    expect(code).toBe(75)
  })

  it('skips the pre-check for --help', async () => {
    const a = await addHfAccount(profile, 'A')
    await fs.writeFile(path.join(hfAccountDir(profile, a.id), 'credentials.json'), '{}')
    await hfProxy({ args: ['generate', 'create', '--help'], env: env(), platform: process.platform, home: profile, run: fakeRunner() })
    expect((await calls()).map((c) => c.args[1])).toEqual(['create'])
  })

  it('stops with "log in again" when the pre-check loses the login', async () => {
    const a = await addHfAccount(profile, 'A')
    const creds = path.join(hfAccountDir(profile, a.id), 'credentials.json')
    await fs.writeFile(creds, '{"t":1}')
    await fs.writeFile(`${creds}.bak`, '{"t":1}')
    const base = fakeRunner()
    // every call deletes the file and fails, so the guard's confirmation fails too
    const run = (args: string[], e: NodeJS.ProcessEnv, t: boolean) => base(args, { ...e, FAKE_HF_DELETE_CREDS: '1', FAKE_HF_EXIT: '2' }, t)
    const code = await hfProxy({ args: ['generate', 'create', 'kling'], env: env(), platform: process.platform, home: profile, run, write: (s) => msgs.push(s) })
    expect(code).toBe(2)
    expect(msgs.join('')).toMatch(/log in again/i)
    expect((await calls()).some((c) => c.args[1] === 'create')).toBe(false)
    expect((await readHfAccounts(profile)).accounts[0].needsLogin).toBe(true)
  })

  it('does not overwrite a credentials file another process wrote while restoring', async () => {
    const a = await addHfAccount(profile, 'A')
    const creds = path.join(hfAccountDir(profile, a.id), 'credentials.json')
    await fs.writeFile(creds, '{"t":"new"}')
    await fs.writeFile(`${creds}.bak`, '{"t":"old"}')
    const run = async () => ({ code: 0, stdout: '', stderr: '' })
    await restoreOnce({ run, args: ['x'], env: {}, profileDir: profile, account: a, creds, first: { code: 1, stdout: '', stderr: '' }, write: () => {} })
    expect(await fs.readFile(creds, 'utf8')).toBe('{"t":"new"}')
  })

  it('forwards stdout before the CLI exits', async () => {
    const seen: string[] = []
    const r = realRunner(process.execPath, process.platform, ['-e', 'process.stdout.write("one");setTimeout(()=>process.stdout.write("two"),1500)'])
    const orig = process.stdout.write.bind(process.stdout)
    let firstAt = 0
    ;(process.stdout as any).write = (s: string) => { if (!firstAt) firstAt = Date.now(); seen.push(String(s)); return true }
    const t0 = Date.now()
    try { await r([], process.env, true) } finally { (process.stdout as any).write = orig }
    expect(seen.join('')).toBe('onetwo')
    expect(firstAt - t0).toBeLessThan(1000)
  })

  it('exits 127 naming the skipped folder when no real CLI is on PATH', async () => {
    const code = await hfProxy({ args: ['x'], env: { ASTERA_PROFILE_DIR: profile, PATH: '' }, platform: process.platform, home: profile, write: (s) => msgs.push(s) })
    expect(code).toBe(127)
    expect(msgs.join('')).toContain(path.join(profile, 'orch'))
  })

  it('never replaces a good backup with an empty or garbled credentials file', async () => {
    const a = await addHfAccount(profile, 'A')
    const creds = path.join(hfAccountDir(profile, a.id), 'credentials.json')
    await fs.writeFile(`${creds}.bak`, '{"t":1}')
    for (const bad of ['', '{"t":', '{}', '[]']) {
      await fs.writeFile(creds, bad)
      await backupCredentials(creds)
      expect(await fs.readFile(`${creds}.bak`, 'utf8')).toBe('{"t":1}')
    }
    await fs.writeFile(creds, '{"t":2}')
    await backupCredentials(creds)
    expect(await fs.readFile(`${creds}.bak`, 'utf8')).toBe('{"t":2}')
    expect((await fs.readdir(path.dirname(creds))).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('does not restore after auth logout, which removes the file on purpose', async () => {
    const a = await addHfAccount(profile, 'A')
    const creds = path.join(hfAccountDir(profile, a.id), 'credentials.json')
    await fs.writeFile(creds, '{"t":1}')
    const code = await hfProxy({ args: ['auth', 'logout'], env: env({ FAKE_HF_DELETE_CREDS: '1' }), platform: process.platform, home: profile, run: fakeRunner(), write: (s) => msgs.push(s) })
    expect(code).toBe(0)
    expect((await calls()).length).toBe(1)
    expect((await readHfAccounts(profile)).accounts[0].needsLogin).toBeFalsy()
    expect(msgs).toEqual([])
  })

  it('still reports "log in again" when the restore itself throws', async () => {
    const a = await addHfAccount(profile, 'A')
    const creds = path.join(hfAccountDir(profile, a.id), 'credentials.json')
    await fs.mkdir(`${creds}.bak`)            // a directory: copyFile from it throws
    const code = await hfProxy({ args: ['x'], env: env({ FAKE_HF_DELETE_CREDS: '1', FAKE_HF_EXIT: '4' }), platform: process.platform, home: profile, run: fakeRunner(), write: (s) => msgs.push(s) })
    expect(code).toBe(4)
    expect(msgs.join('')).toMatch(/log in again/i)
  })

  it.runIf(process.platform === 'win32')('passes cmd metacharacters intact through an npm-style .cmd shim', async () => {
    const dir = path.join(profile, 'npmbin')
    const script = path.join(dir, 'node_modules', '@x', 'cli', 'bin', 'x.js')
    await fs.mkdir(path.dirname(script), { recursive: true })
    await fs.writeFile(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
    await fs.copyFile(process.execPath, path.join(dir, 'node.exe'))
    const shim = path.join(dir, 'x.cmd')
    await fs.writeFile(shim, ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
      String.raw`IF EXIST "%dp0%\node.exe" (`, String.raw`  SET "_prog=%dp0%\node.exe"`, ') ELSE (', '  SET "_prog=node"', ')', '',
      String.raw`endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@x\cli\bin\x.js" %*`, ''].join('\r\n'))
    const args = ['say', 'x & y', '50%PATH% off', 'a^b', 'q"r', 'a&echo INJECTED']
    const r = await realRunner(shim, 'win32')(args, process.env, false)
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual(args)
  })

  it.runIf(process.platform === 'win32')('refuses cmd metacharacters for a .cmd that is not an npm shim', async () => {
    const shim = path.join(profile, 'plain.cmd')
    await fs.writeFile(shim, '@echo off\r\necho hi %*\r\n')
    const r = await realRunner(shim, 'win32')(['a&b'], process.env, false)
    expect(r.code).toBe(2)
    expect(r.stderr).toMatch(/cmd/)
  })

  describe('assets across accounts', () => {
    const U = '11111111-1111-4111-8111-111111111111'
    const J = '22222222-2222-4222-8222-222222222222'
    const ledgerFile = () => path.join(profile, 'higgsfield', 'assets.json')
    const setup = async () => {
      const a = await addHfAccount(profile, 'A'); const b = await addHfAccount(profile, 'B')
      for (const x of [a, b]) await fs.writeFile(path.join(hfAccountDir(profile, x.id), 'credentials.json'), '{}')
      return { a, b }
    }
    const jobRunner = (log: string[][]) => {
      const base = fakeRunner()
      return (args: string[], e: NodeJS.ProcessEnv, t: boolean) => {
        if (args[0] === 'generate' && args[1] === 'get') {
          log.push([args.join(' '), e.HIGGSFIELD_CREDENTIALS_PATH as string])
          return Promise.resolve({ code: 0, stdout: `{"result":{"url":"https://cdn.x/out.mp4?sig=1&e=2"}}`, stderr: '' })
        }
        return base(args, e, t)
      }
    }

    it('swaps an upload id of another account for its file', async () => {
      const { a, b } = await setup()
      const img = path.join(profile, 'img.png'); await fs.writeFile(img, 'x')
      await fs.mkdir(path.join(profile, 'higgsfield'), { recursive: true })
      await fs.writeFile(ledgerFile(), JSON.stringify({ uploads: { [U]: { account: a.id, path: img } }, jobs: {} }))
      await patchHfAccount(profile, b.id, {})
      const { setHfCurrent } = await import('../core/higgsfield/accounts')
      await setHfCurrent(profile, b.id)
      await hfProxy({ args: ['generate', 'create', 'k', '--image', U], env: env(), platform: process.platform, home: profile, run: fakeRunner() })
      const c = (await calls()).find((x) => x.args[1] === 'create')
      expect(c.args).toEqual(['generate', 'create', 'k', '--image', img])
    })

    it('records an upload made under the current account', async () => {
      const { a } = await setup()
      await hfProxy({ args: ['upload', 'create', 'pic.png'], env: env(), platform: process.platform, home: profile, run: fakeRunner() })
      expect((await readLedger(profile)).uploads[U]).toEqual({ account: a.id, path: path.resolve('pic.png') })
    })

    it('does not record after a failed run, and a ledger write failure keeps the exit code', async () => {
      await setup()
      await hfProxy({ args: ['upload', 'create', 'pic.png'], env: env({ FAKE_HF_EXIT: '3' }), platform: process.platform, home: profile, run: fakeRunner() })
      await expect(fs.stat(ledgerFile())).rejects.toThrow()
      await fs.mkdir(ledgerFile(), { recursive: true })   // a directory where the file goes: every write fails
      const code = await hfProxy({ args: ['upload', 'create', 'pic.png'], env: env(), platform: process.platform, home: profile, run: fakeRunner() })
      expect(code).toBe(0)
    })

    it('downloads a job of another account once, under that account, and uses the file', async () => {
      const { a, b } = await setup()
      await fs.mkdir(path.join(profile, 'higgsfield'), { recursive: true })
      await fs.writeFile(ledgerFile(), JSON.stringify({ uploads: {}, jobs: { [J]: { account: a.id } } }))
      const { setHfCurrent } = await import('../core/higgsfield/accounts')
      await setHfCurrent(profile, b.id)
      const gets: string[][] = []; const urls: string[] = []
      const fetchFake = (async (u: string) => { urls.push(u); return new Response('bytes') }) as unknown as typeof fetch
      const go = () => hfProxy({ args: ['generate', 'create', 'k', `--start-image=${J}`], env: env(), platform: process.platform, home: profile, run: jobRunner(gets), fetch: fetchFake })
      await go()
      const file = path.join(profile, 'higgsfield', 'assets', `${J}.mp4`)
      expect(await fs.readFile(file, 'utf8')).toBe('bytes')
      expect(urls).toEqual(['https://cdn.x/out.mp4?sig=1&e=2'])
      expect(gets).toEqual([[`generate get ${J} --json`, path.join(hfAccountDir(profile, a.id), 'credentials.json')]])
      const c = (await calls()).filter((x) => x.args[1] === 'create')
      expect(c[0].args[3]).toBe(`--start-image=${file}`)
      expect((await readLedger(profile)).jobs[J].file).toBe(file)
      await go()   // second time: the file is there, nothing fetched
      expect(urls.length).toBe(1)
      expect(gets.length).toBe(1)
    })

    it('keeps the id and says so once when the download fails', async () => {
      const { a, b } = await setup()
      await fs.mkdir(path.join(profile, 'higgsfield'), { recursive: true })
      await fs.writeFile(ledgerFile(), JSON.stringify({ uploads: {}, jobs: { [J]: { account: a.id } } }))
      const { setHfCurrent } = await import('../core/higgsfield/accounts')
      await setHfCurrent(profile, b.id)
      const fetchFake = (async () => new Response('no', { status: 500 })) as unknown as typeof fetch
      await hfProxy({ args: ['generate', 'create', 'k', '--image', J], env: env(), platform: process.platform, home: profile, run: jobRunner([]), fetch: fetchFake, write: (s) => msgs.push(s) })
      expect((await calls()).find((x) => x.args[1] === 'create').args).toEqual(['generate', 'create', 'k', '--image', J])
      expect(msgs).toEqual([`higgsfield: could not bring ${J} over from account "A"; passing it through
`])
      const left = await fs.readdir(path.join(profile, 'higgsfield', 'assets')).catch(() => [])
      expect(left).toEqual([])
    })

    it('keeps the id and says so once when the download hangs past the timeout', async () => {
      const { a, b } = await setup()
      await fs.mkdir(path.join(profile, 'higgsfield'), { recursive: true })
      await fs.writeFile(ledgerFile(), JSON.stringify({ uploads: {}, jobs: { [J]: { account: a.id } } }))
      const { setHfCurrent } = await import('../core/higgsfield/accounts')
      await setHfCurrent(profile, b.id)
      const hang = ((_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(init.signal!.reason))
      })) as unknown as typeof fetch
      await hfProxy({ args: ['generate', 'create', 'k', '--image', J], env: env(), platform: process.platform, home: profile, run: jobRunner([]), fetch: hang, downloadTimeoutMs: 50, write: (s) => msgs.push(s) })
      expect((await calls()).find((x) => x.args[1] === 'create').args).toEqual(['generate', 'create', 'k', '--image', J])
      expect(msgs).toEqual([`higgsfield: could not bring ${J} over from account "A"; passing it through
`])
    }, 10000)
  })

  describe('which CLI the name finds', () => {
    // Bins found through PATH the way production finds them: an npm .cmd on win32, a symlink elsewhere.
    const install = async (dir: string, name: string, rel: string, body: string) => {
      const script = path.join(dir, 'node_modules', ...rel.split('/'))
      await fs.mkdir(path.dirname(script), { recursive: true })
      await fs.writeFile(script, body, { mode: 0o755 })
      if (process.platform === 'win32') {
        await fs.writeFile(path.join(dir, `${name}.cmd`), ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
          String.raw`IF EXIST "%dp0%\node.exe" (`, String.raw`  SET "_prog=%dp0%\node.exe"`, ') ELSE (', '  SET "_prog=node"', ')', '',
          `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\${rel.split('/').join('\\')}" %*`, ''].join('\r\n'))
      } else {
        await fs.symlink(script, path.join(dir, name))
      }
    }
    const HUGGING = `#!/usr/bin/env node
import fs from 'node:fs'
const e = process.env
fs.appendFileSync(e.FAKE_HF_LOG, JSON.stringify({ hugging: true, args: process.argv.slice(2), creds: e.HIGGSFIELD_CREDENTIALS_PATH ?? null, cfg: e.HIGGSFIELD_CONFIG_PATH ?? null }) + '\\n')
if (e.HIGGSFIELD_CREDENTIALS_PATH) fs.rmSync(e.HIGGSFIELD_CREDENTIALS_PATH, { force: true })
process.exit(7)
`
    // PATH holds only the test's folders and a folder with node alone in it: node's own install folder
    // can hold the real higgsfield CLI, which a test must never run.
    const pathEnv = async (dirs: string[]) => {
      const nodeDir = path.join(profile, 'nodebin')
      const node = path.join(nodeDir, path.basename(process.execPath))
      await fs.mkdir(nodeDir, { recursive: true })
      if (process.platform === 'win32') await fs.link(process.execPath, node).catch(() => fs.copyFile(process.execPath, node))
      else await fs.symlink(process.execPath, path.join(nodeDir, 'node'))
      const e: NodeJS.ProcessEnv = {}
      for (const [k, v] of Object.entries(process.env)) if (k.toUpperCase() !== 'PATH') e[k] = v
      e.PATH = [...dirs, nodeDir].join(path.delimiter)
      return { ...e, ASTERA_PROFILE_DIR: profile, FAKE_HF_LOG: logFile }
    }
    const withAccount = async () => {
      const a = await addHfAccount(profile, 'A')
      const creds = path.join(hfAccountDir(profile, a.id), 'credentials.json')
      await fs.writeFile(creds, '{"t":1}')
      await fs.writeFile(`${creds}.bak`, '{"t":1}')
      return creds
    }

    it('runs another program named hf untouched: no account, no guard, no messages', async () => {
      const creds = await withAccount()
      const hug = path.join(profile, 'hug'); const hig = path.join(profile, 'hig')
      await install(hug, 'hf', 'huggingface_hub/hf.mjs', HUGGING)
      await install(hig, 'hf', '@higgsfield/cli/bin/higgsfield.mjs', await fs.readFile(FAKE, 'utf8'))
      const code = await hfProxy({ args: ['--as=hf', 'generate', 'create', 'x'], env: await pathEnv([hug, hig]), platform: process.platform, home: profile, write: (s) => msgs.push(s) })
      expect(code).toBe(7)
      expect(await calls()).toEqual([{ hugging: true, args: ['generate', 'create', 'x'], creds: null, cfg: null }])
      expect(msgs).toEqual([])
      expect(await fs.readFile(creds, 'utf8')).toBe('{"t":1}')
      expect((await readHfAccounts(profile)).accounts[0].needsLogin).toBeFalsy()
    }, 30000)

    it('runs the Higgsfield hf under the account when it comes first, without the --as word', async () => {
      const creds = await withAccount()
      const hug = path.join(profile, 'hug'); const hig = path.join(profile, 'hig')
      await install(hug, 'hf', 'huggingface_hub/hf.mjs', HUGGING)
      await install(hig, 'hf', '@higgsfield/cli/bin/higgsfield.mjs', await fs.readFile(FAKE, 'utf8'))
      const code = await hfProxy({ args: ['--as=hf', 'model', 'list'], env: await pathEnv([hig, hug]), platform: process.platform, home: profile, write: (s) => msgs.push(s) })
      expect(code).toBe(0)
      expect(await calls()).toEqual([{ args: ['model', 'list'], creds }])
    }, 30000)
  })
})

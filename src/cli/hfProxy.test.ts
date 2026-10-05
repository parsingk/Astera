import { describe, it, expect, beforeEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { backupCredentials, hfProxy, realRunner } from './hfProxy'
import { addHfAccount, hfAccountDir, readHfAccounts } from '../core/higgsfield/accounts'

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
})

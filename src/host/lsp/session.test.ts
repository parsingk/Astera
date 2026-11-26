import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LspProblem } from '../../core/lsp/model'
import { pyrightConfiguration, pythonPathFor } from '../../core/lsp/servers'
import { languageServersOf } from '../../core/settings/languageServers'
import { lspLaunch, startLspSession, type LspLaunch } from './session'

// Phase 3 Part 3: one language server process, driven against a fake server (fixtures/fake-lsp.mjs) run by this Node
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-lsp.mjs')
let root: string
const spawned: ChildProcess[] = []
const spawn = ((file: string, args: readonly string[], opts: object) => {
  const c = nodeSpawn(file, args, opts)
  spawned.push(c)
  return c
}) as unknown as typeof nodeSpawn

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'astera-lsp-session-'))
})
afterEach(async () => {
  // Every fake server this test started has ended
  await vi.waitFor(() => {
    for (const c of spawned) expect(c.exitCode !== null || c.signalCode !== null, `pid ${c.pid}`).toBe(true)
  }, { timeout: 8000 })
  spawned.length = 0
  rmSync(root, { recursive: true, force: true })
})

const launch = (mode: string, env: Record<string, string> = {}, over: Partial<LspLaunch> = {}): LspLaunch => ({
  server: 'typescript',
  root,
  file: process.execPath,
  args: [FIXTURE, '--stdio'],
  env: { ...process.env, FAKE_LSP_MODE: mode, ...env },
  log: path.join(root, 'logs', 'fake.log'),
  ...over
})

function run(l: LspLaunch, timings: Parameters<typeof startLspSession>[1]['timings'] = {}) {
  const calls: Array<[string, LspProblem[]]> = []
  const exits: Array<{ crashed: boolean; reason: string }> = []
  let ready = false
  const session = startLspSession(l, {
    spawn,
    timings,
    onDiagnostics: (p, problems) => calls.push([p, problems]),
    onReady: () => (ready = true),
    onExit: (why) => exits.push(why)
  })
  const latest = (p: string): LspProblem[] | undefined => calls.filter(([q]) => q === p).at(-1)?.[1]
  return { session, calls, exits, latest, ready: () => ready }
}

describe('startLspSession', () => {
  it('pulls diagnostics for an opened file and gives them 1-based', async () => {
    const r = run(launch('pull'))
    const file = path.join(root, 'a.ts')
    r.session.open(file, 'ok\nERROR here\n')
    await vi.waitFor(() => expect(r.latest(file)).toEqual([{ line: 2, column: 1, endLine: 2, endColumn: 6, severity: 'error', message: 'error on line 2', code: '9999' }]), { timeout: 8000 })
    expect(r.ready()).toBe(true)
    await r.session.shutdown()
    expect(r.exits).toEqual([{ crashed: false, reason: expect.any(String) }])
  })

  it('takes pushed diagnostics when the server pulls nothing, and clears a file it closes', async () => {
    const r = run(launch('push'))
    const file = path.join(root, 'b.py')
    r.session.open(file, 'ERROR\n')
    await vi.waitFor(() => expect(r.latest(file)?.[0]).toMatchObject({ line: 1, message: 'error on line 1' }), { timeout: 8000 })
    r.session.close(file)
    expect(r.latest(file)).toEqual([])
    await r.session.shutdown()
  })

  it('drops a result for an older version after the file was sent again', async () => {
    const r = run(launch('pull', { FAKE_LSP_PULL_DELAY_MS: '300' }))
    await vi.waitFor(() => expect(r.ready()).toBe(true), { timeout: 8000 })
    const file = path.join(root, 'c.ts')
    r.session.open(file, 'ERROR one\n')
    r.session.open(file, 'fine\nERROR two\n')
    await vi.waitFor(() => expect(r.latest(file)?.[0]?.line).toBe(2), { timeout: 8000 })
    await new Promise((res) => setTimeout(res, 400))
    expect(r.calls.filter(([p]) => p === file).some(([, probs]) => probs.some((x) => x.line === 1))).toBe(false)
    await r.session.shutdown()
  })

  it('gives up on initialize after its timeout and reports a crash with the reason', async () => {
    const r = run(launch('silent'), { initializeMs: 300 })
    await vi.waitFor(() => expect(r.exits).toHaveLength(1), { timeout: 8000 })
    expect(r.exits[0].crashed).toBe(true)
    expect(r.exits[0].reason).toMatch(/initialize/)
    expect(r.ready()).toBe(false)
  })

  it('keeps at most 200 problems a file and the log within budget', async () => {
    const l = launch('flood')
    const r = run(l)
    const file = path.join(root, 'd.ts')
    r.session.open(file, 'x\n')
    await vi.waitFor(() => expect(r.latest(file)).toHaveLength(200), { timeout: 15000 })
    await r.session.shutdown()
    const lines = readFileSync(l.log, 'utf8').split('\n').filter(Boolean)
    expect(lines.length).toBeLessThan(5000)
    expect(lines.some((x) => /dropped \d+ line/.test(x))).toBe(true)
  })

  it('reports a crash when the process exits on its own', async () => {
    const r = run(launch('crash'))
    await vi.waitFor(() => expect(r.exits).toHaveLength(1), { timeout: 8000 })
    expect(r.exits[0]).toMatchObject({ crashed: true })
    expect(r.exits[0].reason).toMatch(/3/)
  })

  it('reports no crash after shutdown, even when the server exits with code 1 (TypeScript 7 does)', async () => {
    const r = run(launch('pull', { FAKE_LSP_EXIT_CODE: '1' }))
    await vi.waitFor(() => expect(r.ready()).toBe(true), { timeout: 8000 })
    await r.session.shutdown()
    expect(r.exits).toEqual([{ crashed: false, reason: expect.any(String) }])
  })

  it('answers workspace/configuration, pulls on a dynamic registration, and again on refresh', async () => {
    const answer = pythonPathFor(null, root)
    const r = run(launch('config', {}, { configuration: (section) => pyrightConfiguration(section, answer) }))
    const file = path.join(root, 'e.py')
    r.session.open(file, 'x = 1\n')
    await vi.waitFor(() => expect(r.latest(file)?.[0]?.message).toContain(answer.pythonPath), { timeout: 8000 })
    expect(r.latest(file)?.[0]?.message).toContain('"reportMissingImports":"none"')
    // The pyright section is answered null
    expect(r.latest(file)?.[0]?.message.endsWith('|null')).toBe(true)
    await r.session.shutdown()
  })

  it.runIf(process.platform === 'win32')('matches the server’s lower-case encoded drive to the opened document', async () => {
    const r = run(launch('uri-lower'))
    const file = path.join(root, '한 글.ts')
    r.session.open(file, 'ERROR\n')
    await vi.waitFor(() => expect(r.latest(file)?.[0]?.line).toBe(1), { timeout: 8000 })
    await r.session.shutdown()
  })
})

describe('lspLaunch', () => {
  const base = (over: Partial<Parameters<typeof lspLaunch>[0]> = {}): Parameters<typeof lspLaunch>[0] => ({
    server: 'python',
    root: path.resolve('proj'),
    profileDir: path.resolve('prof'),
    exec: path.resolve('electron.exe'),
    env: { PATH: 'p', ASTERA_SESSION: 's', ELECTRON_RUN_AS_NODE: '1' },
    settings: languageServersOf(undefined),
    platform: 'win32',
    arch: 'x64',
    exists: () => true,
    ...over
  })

  it('refuses a launch whose server file is missing', () => {
    expect(lspLaunch(base({ exists: () => false }))).toEqual({ refused: expect.stringContaining('langserver.index.js') })
    expect(lspLaunch(base({ server: 'typescript', platform: 'freebsd' }))).toEqual({ refused: expect.any(String) })
  })

  it('never names a .cmd interpreter to pyright, and runs it on the Host’s Node without the current folder on the search path', () => {
    const l = lspLaunch(base({ pythonPath: pythonPathFor(path.resolve('py', 'python.cmd'), path.resolve('prof')) })) as LspLaunch
    expect(l.file).toBe(path.resolve('electron.exe'))
    expect(l.args[0].endsWith(path.join('pyright@1.1.414', 'package', 'langserver.index.js'))).toBe(true)
    expect(l.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(l.env.NoDefaultCurrentDirectoryInExePath).toBe('1')
    expect(l.env.ASTERA_SESSION).toBeUndefined()
    expect((l.configuration?.('python') as { pythonPath: string }).pythonPath).toBe(path.join(path.resolve('prof'), 'language-servers', 'no-python', 'python'))
    expect(l.log).toMatch(/[\\/]logs[\\/]python-[0-9a-f]{8}\.log$/)
  })

  it('gives typescript5 a tsserver path it checked, and no typings installer', () => {
    const l = lspLaunch(base({ server: 'typescript5' })) as LspLaunch
    expect(l.args[0].endsWith(path.join('typescript-language-server@6.1.0', 'package', 'lib', 'cli.mjs'))).toBe(true)
    const opts = l.initializationOptions as { tsserver: { path: string }; disableAutomaticTypingAcquisition: boolean }
    expect(opts.tsserver.path.endsWith(path.join('typescript@5.9.3', 'package', 'lib', 'tsserver.js'))).toBe(true)
    expect(opts.disableAutomaticTypingAcquisition).toBe(true)
    expect(l.env.TEMP).toBe(path.join(path.resolve('prof'), 'language-servers', 'tmp'))
    expect(lspLaunch(base({ server: 'typescript5', exists: (p) => !p.endsWith('tsserver.js') }))).toEqual({ refused: expect.stringContaining('tsserver.js') })
  })

  it('runs TypeScript 7’s own binary with --lsp --stdio, or the path the person set', () => {
    const l = lspLaunch(base({ server: 'typescript' })) as LspLaunch
    expect(l.file.endsWith(path.join('typescript+typescript-win32-x64@7.0.2', 'package', 'lib', 'tsc.exe'))).toBe(true)
    expect(l.args).toEqual(['--lsp', '--stdio'])
    expect(l.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    const own = path.resolve('ts', 'tsc.exe')
    expect((lspLaunch(base({ server: 'typescript', settings: languageServersOf({ typescript: { path: own } }) })) as LspLaunch).file).toBe(own)
  })
})

// Which hooks Codex loads for a shared plugin, and the key and hash it files them under, depend on how the plugin's
// manifest spells its hooks, so Astera asks Codex itself (`codex app-server`, `hooks/list`) and writes trust for what
// it answers. No test starts a real codex: the child is a fake that answers each request line the way the measured
// codex-cli 0.160 does (newline-delimited JSON-RPC, notifications at any moment).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SpawnOptions } from 'node:child_process'
import { killProcessTree } from '../../run/kill'
import { removeFixture } from '../../testFixtures'
import { patchTomlFile, readTomlObject } from '../../providers/configWrite'
import { resolveCliCommand } from '../claudePlugins/cli'
import { codexPluginCliEnv } from './cli'
import { createCodexHooksList, trustPatch } from './hooks'

vi.mock('../../run/kill', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../run/kill')>()
  return { ...real, killProcessTree: vi.fn(real.killProcessTree) }
})

// Only the refusal test changes the answer; every other run goes through the real lookup, with refreshPath left out.
vi.mock('../claudePlugins/cli', async (importOriginal) => {
  const real = await importOriginal<typeof import('../claudePlugins/cli')>()
  return { ...real, resolveCliCommand: vi.fn(real.resolveCliCommand) }
})

beforeEach(() => {
  vi.mocked(killProcessTree).mockClear()
})

const HOME = path.join(os.tmpdir(), 'astera-codex-account')
const CWD = path.join(os.tmpdir(), 'astera-codex-cwd')
const noRefresh = (): void => {}

interface Msg { id?: number; method?: string; params?: unknown }
interface Call { file: string; args: string[]; opts: SpawnOptions }
type FakeChild = EventEmitter & {
  stdin: EventEmitter & { write(chunk: string): boolean }
  stdout: EventEmitter & { setEncoding(): void }
  stderr: EventEmitter & { setEncoding(): void }
  pid: undefined
  exitCode: number | null
  signalCode: string | null
  kill(): boolean
}

/** A child that reads one JSON message per stdin line and, after each, writes what `reply` returns (objects become a
 *  line each, strings are written as they are). `reply` returning nothing leaves the child silent. pid stays undefined
 *  so the real killProcessTree falls back to kill() and no taskkill ever meets a made-up pid. */
function fakeAppServer(reply: (m: Msg) => (object | string)[] | undefined, o: { onSpawn?: (child: FakeChild) => void } = {}): {
  spawn: typeof import('node:child_process').spawn
  calls: Call[]
  written: string[]
  messages: Msg[]
  child: () => FakeChild
} {
  const calls: Call[] = []
  const written: string[] = []
  const messages: Msg[] = []
  let made: FakeChild | undefined
  const spawn = ((file: string, args: string[], opts: SpawnOptions) => {
    calls.push({ file, args, opts })
    const stream = (): EventEmitter & { setEncoding(): void } => Object.assign(new EventEmitter(), { setEncoding: () => undefined })
    const child: FakeChild = Object.assign(new EventEmitter(), {
      stdin: Object.assign(new EventEmitter(), {
        write: (chunk: string): boolean => {
          written.push(chunk)
          for (const line of chunk.split('\n').filter((l) => l !== '')) {
            const m = JSON.parse(line) as Msg
            messages.push(m)
            const out = reply(m)
            if (out === undefined) continue
            setImmediate(() => {
              for (const x of out) child.stdout.emit('data', typeof x === 'string' ? x : `${JSON.stringify(x)}\n`)
            })
          }
          return true
        }
      }),
      stdout: stream(),
      stderr: stream(),
      pid: undefined,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill: (): boolean => {
        child.signalCode = 'SIGTERM'
        child.emit('exit', null, 'SIGTERM')
        child.emit('close', null, 'SIGTERM')
        return true
      }
    })
    made = child
    o.onSpawn?.(child)
    return child
  }) as unknown as typeof import('node:child_process').spawn
  return { spawn, calls, written, messages, child: () => made as FakeChild }
}

const probeRow = {
  key: 'probe@astera-shared:hooks/hooks.json:pre_tool_use:0:0',
  eventName: 'preToolUse',
  handlerType: 'command',
  command: 'node probe.js',
  source: 'plugin',
  pluginId: 'probe@astera-shared',
  enabled: true,
  currentHash: 'sha256:ecc5f21bd8f5bf61ba67eac85286ed3bf197c366c23774c388cc4b1aab2647a8',
  trustStatus: 'untrusted'
}
/** A hook the person wrote in their own config.toml: no plugin behind it. */
const ownRow = {
  key: 'config.toml:session_start:0:0',
  eventName: 'sessionStart',
  handlerType: 'command',
  command: 'echo hi',
  source: 'user',
  enabled: true,
  currentHash: 'sha256:00aa',
  trustStatus: 'trusted'
}

/** Answers initialize (after a notification of Codex's own), ignores `initialized`, answers hooks/list with `data`. */
const answering =
  (data: unknown) =>
  (m: Msg): (object | string)[] | undefined => {
    if (m.method === 'initialize') return [{ method: 'remoteControl/status/changed', params: { status: 'disabled' } }, { id: m.id, result: { userAgent: 'codex/0.160.0' } }]
    if (m.method === 'hooks/list') return [{ method: 'remoteControl/status/changed', params: {} }, { id: m.id, result: { data } }]
    return undefined
  }

const entry = (hooks: unknown[]): unknown => ({ cwd: CWD, hooks, warnings: [], errors: [] })

describe('createCodexHooksList', () => {
  it('writes initialize, the initialized notification and hooks/list in that order, and maps the answered hooks to rows', async () => {
    const fake = fakeAppServer(answering([entry([probeRow, ownRow])]))
    const list = createCodexHooksList({ platform: 'linux', baseEnv: { PATH: '/usr/bin' }, spawn: fake.spawn, refreshPath: noRefresh })
    const rows = await list(HOME, CWD)
    expect(rows).toEqual([
      { key: probeRow.key, pluginId: 'probe@astera-shared', currentHash: probeRow.currentHash, trustStatus: 'untrusted' },
      { key: ownRow.key, pluginId: null, currentHash: 'sha256:00aa', trustStatus: 'trusted' }
    ])
    // The notification is the only message with no id, and every message is one line
    expect(fake.written.every((w) => w.endsWith('\n') && w.indexOf('\n') === w.length - 1)).toBe(true)
    expect(fake.messages.map((m) => m.method)).toEqual(['initialize', 'initialized', 'hooks/list'])
    expect(fake.messages[0]).toMatchObject({ params: { clientInfo: { name: 'astera', version: expect.any(String) } } })
    expect(fake.messages[0].id).toEqual(expect.any(Number))
    expect(fake.messages[1]).not.toHaveProperty('id')
    expect(fake.messages[2]).toMatchObject({ id: expect.any(Number), params: { cwds: [CWD] } })
    expect(fake.messages[2].id).not.toBe(fake.messages[0].id)
  })

  it('maps every hook of every answered cwd', async () => {
    const fake = fakeAppServer(answering([entry([probeRow]), entry([ownRow]), entry([])]))
    const list = createCodexHooksList({ platform: 'linux', baseEnv: {}, spawn: fake.spawn, refreshPath: noRefresh })
    expect((await list(HOME, CWD)).map((r) => r.key)).toEqual([probeRow.key, ownRow.key])
  })

  it('spawns codex app-server in the cwd with the account environment, and kills its tree when it has the answer', async () => {
    const fake = fakeAppServer(answering([entry([probeRow])]))
    const base = { PATH: '/usr/bin', CODEX_HOME: 'ambient', CLAUDECODE: '1', ASTERA_X: '1' }
    await createCodexHooksList({ platform: 'linux', baseEnv: base, spawn: fake.spawn, refreshPath: noRefresh })(HOME, CWD)
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].file).toBe('codex')
    expect(fake.calls[0].args).toEqual(['app-server'])
    expect(fake.calls[0].opts.cwd).toBe(CWD)
    expect(fake.calls[0].opts.env).toEqual(codexPluginCliEnv(base, HOME))
    expect(fake.calls[0].opts.env).toEqual({ PATH: '/usr/bin', CODEX_HOME: HOME })
    expect(fake.calls[0].opts.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    expect(killProcessTree).toHaveBeenCalledTimes(1)
    expect(vi.mocked(killProcessTree).mock.calls[0][0]).toBe(fake.child())
  })

  it('runs the ambient account with no CODEX_HOME', async () => {
    const fake = fakeAppServer(answering([]))
    await createCodexHooksList({ platform: 'linux', baseEnv: { PATH: '/usr/bin', CODEX_HOME: 'elsewhere' }, spawn: fake.spawn, refreshPath: noRefresh })(null, CWD)
    expect(fake.calls[0].opts.env).toEqual({ PATH: '/usr/bin' })
  })

  it('reads baseEnv after the PATH refresh', async () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    const refreshPath = (): void => {
      env.PATH = '/home/u/.local/bin:/usr/bin'
    }
    const fake = fakeAppServer(answering([]))
    await createCodexHooksList({ platform: 'linux', baseEnv: () => env, spawn: fake.spawn, refreshPath })(HOME, CWD)
    expect(fake.calls[0].opts.env).toEqual({ PATH: '/home/u/.local/bin:/usr/bin', CODEX_HOME: HOME })
  })

  it('finds codex on win32 the way sessions do', async () => {
    const fake = fakeAppServer(answering([]))
    const list = createCodexHooksList({
      platform: 'win32',
      baseEnv: {},
      spawn: fake.spawn,
      resolve: (name) => (name === 'codex' ? 'C:\\tools\\codex.exe' : null),
      warm: async () => null,
      refreshPath: noRefresh
    })
    await list(HOME, CWD)
    expect(fake.calls[0].file).toBe('C:\\tools\\codex.exe')
    expect(fake.calls[0].args).toEqual(['app-server'])
  })

  it('sends nothing after initialize until Codex has answered it', async () => {
    const fake = fakeAppServer(() => undefined)
    const list = createCodexHooksList({ platform: 'linux', baseEnv: {}, spawn: fake.spawn, refreshPath: noRefresh, timeoutMs: 40 })
    await expect(list(HOME, CWD)).rejects.toThrow(/did not answer/)
    expect(fake.messages.map((m) => m.method)).toEqual(['initialize'])
  })

  it('ignores notifications, requests of its own and lines that are not JSON, and joins an answer cut across chunks', async () => {
    const answer = JSON.stringify({ id: 2, result: { data: [entry([probeRow])] } })
    const fake = fakeAppServer((m) => {
      if (m.method === 'initialize') return ['starting codex\n', { method: 'remoteControl/status/changed' }, { id: 1, result: {} }]
      // A request Codex makes of its client carries an id too, but it also carries a method: it is not the answer
      if (m.method === 'hooks/list') return [{ id: 2, method: 'client/ask', params: {} }, { method: 'x' }, answer.slice(0, 30), `${answer.slice(30)}\n`]
      return undefined
    })
    const rows = await createCodexHooksList({ platform: 'linux', baseEnv: {}, spawn: fake.spawn, refreshPath: noRefresh })(HOME, CWD)
    expect(rows.map((r) => r.key)).toEqual([probeRow.key])
  })

  it('skips a hook row that lacks a key, a hash or a trust status', async () => {
    const fake = fakeAppServer(answering([entry([{ ...probeRow, key: undefined }, { ...probeRow, currentHash: 5 }, { source: 'user' }, null, ownRow])]))
    const rows = await createCodexHooksList({ platform: 'linux', baseEnv: {}, spawn: fake.spawn, refreshPath: noRefresh })(HOME, CWD)
    expect(rows.map((r) => r.key)).toEqual([ownRow.key])
  })

  it('rejects an answer that has no data list instead of reading it as no hooks', async () => {
    for (const data of [undefined, null, 'x', {}]) {
      const fake = fakeAppServer(answering(data))
      const list = createCodexHooksList({ platform: 'linux', baseEnv: {}, spawn: fake.spawn, refreshPath: noRefresh })
      await expect(list(HOME, CWD)).rejects.toThrow(/hooks\/list/)
      expect(killProcessTree).toHaveBeenCalled()
      vi.mocked(killProcessTree).mockClear()
    }
  })

  it('rejects after timeoutMs when the child never answers, and kills its tree', async () => {
    const fake = fakeAppServer(() => undefined)
    const list = createCodexHooksList({ platform: 'linux', baseEnv: {}, spawn: fake.spawn, refreshPath: noRefresh, timeoutMs: 50 })
    await expect(list(HOME, CWD)).rejects.toThrow('codex app-server did not answer initialize within 0 s')
    expect(killProcessTree).toHaveBeenCalledTimes(1)
    expect(vi.mocked(killProcessTree).mock.calls[0][0]).toBe(fake.child())
  })

  it('names the step that was waiting for its answer when the time passes', async () => {
    const fake = fakeAppServer((m) => (m.method === 'initialize' ? [{ id: m.id, result: {} }] : undefined))
    const list = createCodexHooksList({ platform: 'linux', baseEnv: {}, spawn: fake.spawn, refreshPath: noRefresh, timeoutMs: 50 })
    await expect(list(HOME, CWD)).rejects.toThrow('did not answer hooks/list')
    expect(killProcessTree).toHaveBeenCalledTimes(1)
  })

  it('rejects with the message of a JSON-RPC error answer, and kills the tree', async () => {
    const fake = fakeAppServer((m) => (m.method === 'initialize' ? [{ id: m.id, result: {} }] : m.method === 'hooks/list' ? [{ id: m.id, error: { code: -32600, message: 'cwd is not a directory' } }] : undefined))
    const list = createCodexHooksList({ platform: 'linux', baseEnv: {}, spawn: fake.spawn, refreshPath: noRefresh })
    await expect(list(HOME, CWD)).rejects.toThrow('cwd is not a directory')
    expect(killProcessTree).toHaveBeenCalledTimes(1)
  })

  it('rejects with the message of an error answered to initialize, and sends nothing more', async () => {
    const fake = fakeAppServer((m) => [{ id: m.id, error: { code: -32602, message: 'Invalid params: clientInfo.version' } }])
    const list = createCodexHooksList({ platform: 'linux', baseEnv: {}, spawn: fake.spawn, refreshPath: noRefresh })
    await expect(list(HOME, CWD)).rejects.toThrow('Invalid params: clientInfo.version')
    expect(fake.messages.map((m) => m.method)).toEqual(['initialize'])
  })

  it('rejects with its stderr tail when the child exits before answering', async () => {
    const fake = fakeAppServer(() => undefined, {
      onSpawn: (child) => {
        setImmediate(() => {
          child.stderr.emit('data', 'warming up\n')
          child.stderr.emit('data', 'Error: unsupported subcommand app-server\n')
          child.exitCode = 2
          child.emit('exit', 2, null)
          child.emit('close', 2, null)
        })
      }
    })
    const list = createCodexHooksList({ platform: 'linux', baseEnv: {}, spawn: fake.spawn, refreshPath: noRefresh })
    await expect(list(HOME, CWD)).rejects.toThrow('warming up\nError: unsupported subcommand app-server')
  })

  it('keeps only the end of a long stderr', async () => {
    const fake = fakeAppServer(() => undefined, {
      onSpawn: (child) => {
        setImmediate(() => {
          child.stderr.emit('data', `${'x'.repeat(5000)}THE END\n`)
          child.exitCode = 1
          child.emit('close', 1, null)
        })
      }
    })
    const error = await createCodexHooksList({ platform: 'linux', baseEnv: {}, spawn: fake.spawn, refreshPath: noRefresh })(HOME, CWD).catch((e: unknown) => e as Error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message.endsWith('THE END')).toBe(true)
    expect((error as Error).message.length).toBeLessThan(1000)
  })

  it('says so when the child exits before answering and wrote nothing to stderr', async () => {
    const fake = fakeAppServer(() => undefined, {
      onSpawn: (child) => {
        setImmediate(() => {
          child.exitCode = 3
          child.emit('close', 3, null)
        })
      }
    })
    const list = createCodexHooksList({ platform: 'linux', baseEnv: {}, spawn: fake.spawn, refreshPath: noRefresh })
    await expect(list(HOME, CWD)).rejects.toThrow('codex app-server exited with code 3 before it answered')
  })

  it('rejects when codex cannot be started', async () => {
    const fake = fakeAppServer(() => undefined, {
      onSpawn: (child) => {
        setImmediate(() => child.emit('error', new Error('spawn codex ENOENT')))
      }
    })
    const list = createCodexHooksList({ platform: 'linux', baseEnv: {}, spawn: fake.spawn, refreshPath: noRefresh })
    await expect(list(HOME, CWD)).rejects.toThrow('spawn codex ENOENT')
    expect(killProcessTree).toHaveBeenCalledTimes(1)
  })

  it('rejects when spawn itself throws', async () => {
    const spawn = (() => {
      throw new Error('EACCES: cannot start codex')
    }) as unknown as typeof import('node:child_process').spawn
    const list = createCodexHooksList({ platform: 'linux', baseEnv: {}, spawn, refreshPath: noRefresh })
    await expect(list(HOME, CWD)).rejects.toThrow('EACCES: cannot start codex')
  })

  it('does not fail on a write to a pipe that closed, and leaves the failure to the exit', async () => {
    const fake = fakeAppServer(() => undefined, {
      onSpawn: (child) => {
        setImmediate(() => {
          child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
          child.stderr.emit('data', 'codex died\n')
          child.exitCode = 1
          child.emit('close', 1, null)
        })
      }
    })
    const list = createCodexHooksList({ platform: 'linux', baseEnv: {}, spawn: fake.spawn, refreshPath: noRefresh })
    await expect(list(HOME, CWD)).rejects.toThrow('codex died')
  })

  it('rejects with the refusal text when nothing can be run, and starts nothing', async () => {
    vi.mocked(resolveCliCommand).mockResolvedValueOnce({ refused: 'codex.cmd runs through cmd, which reads "a&b" as syntax; nothing was run' })
    const fake = fakeAppServer(answering([]))
    const list = createCodexHooksList({ platform: 'win32', baseEnv: {}, spawn: fake.spawn, refreshPath: noRefresh })
    await expect(list(HOME, CWD)).rejects.toThrow('codex.cmd runs through cmd, which reads "a&b" as syntax; nothing was run')
    expect(fake.calls).toHaveLength(0)
    expect(killProcessTree).not.toHaveBeenCalled()
  })

  it('asks resolveCliCommand for codex app-server with the platform and lookups it was given', async () => {
    const fake = fakeAppServer(answering([]))
    const resolve = (): null => null
    const warm = async (): Promise<null> => null
    await createCodexHooksList({ platform: 'darwin', baseEnv: { PATH: '/usr/bin' }, spawn: fake.spawn, resolve, warm, refreshPath: noRefresh })(HOME, CWD)
    expect(resolveCliCommand).toHaveBeenLastCalledWith(
      { name: 'codex', platform: 'darwin', resolve, warm, refreshPath: noRefresh },
      ['app-server'],
      expect.any(Function)
    )
  })
})

describe('trustPatch', () => {
  const KEY = 'probe@astera-shared:hooks/hooks.json:pre_tool_use:0:0'
  const HASH = 'sha256:ecc5f21bd8f5bf61ba67eac85286ed3bf197c366c23774c388cc4b1aab2647a8'
  const never = (): boolean => false
  /** What readTomlObject returns, tables with no prototype included. */
  const parsed = (toml: string): Record<string, unknown> => readTomlObject(toml)
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

  it('adds the trusted hash of a key to hooks.state', () => {
    const next = trustPatch({}, { trust: [{ key: KEY, hash: HASH }], drop: never })
    expect(next).toEqual({ hooks: { state: { [KEY]: { trusted_hash: HASH } } } })
  })

  it('keeps a person\'s hooks.state key, the other keys of hooks and of the file', () => {
    const current = parsed(
      [
        'model = "gpt-5"',
        '',
        '[hooks]',
        'timeout = 30',
        '',
        '[hooks.state."mine:hooks.json:stop:0:0"]',
        'trusted_hash = "sha256:aa"',
        '',
        '[mcp_servers.x]',
        'command = "x"'
      ].join('\n')
    )
    const next = trustPatch(current, { trust: [{ key: KEY, hash: HASH }], drop: never })
    expect(next).toEqual({
      model: 'gpt-5',
      hooks: { timeout: 30, state: { 'mine:hooks.json:stop:0:0': { trusted_hash: 'sha256:aa' }, [KEY]: { trusted_hash: HASH } } },
      mcp_servers: { x: { command: 'x' } }
    })
    expect(Object.keys(next)).toEqual(['model', 'hooks', 'mcp_servers'])
  })

  it('replaces the hash of a key that is already there and keeps the other fields of its entry', () => {
    const current = parsed(`[hooks.state."${KEY}"]\nenabled = false\ntrusted_hash = "sha256:old"\n`)
    const next = trustPatch(current, { trust: [{ key: KEY, hash: HASH }], drop: never })
    expect(next).toEqual({ hooks: { state: { [KEY]: { enabled: false, trusted_hash: HASH } } } })
  })

  it('removes the keys drop picks, and no other', () => {
    const own = 'probe@astera-shared:'
    const current = parsed(
      [`[hooks.state."${own}old.json:stop:0:0"]`, 'trusted_hash = "sha256:1"', '', `[hooks.state."other@x:hooks.json:stop:0:0"]`, 'trusted_hash = "sha256:2"'].join('\n')
    )
    const next = trustPatch(current, { trust: [{ key: KEY, hash: HASH }], drop: (k) => k.startsWith(own) && k !== KEY })
    expect(next).toEqual({ hooks: { state: { 'other@x:hooks.json:stop:0:0': { trusted_hash: 'sha256:2' }, [KEY]: { trusted_hash: HASH } } } })
  })

  it('trusts a key that drop also names: the key Codex lists now is the one that stays', () => {
    const current = parsed(`[hooks.state."${KEY}"]\ntrusted_hash = "sha256:old"\n`)
    const next = trustPatch(current, { trust: [{ key: KEY, hash: HASH }], drop: () => true })
    expect(next).toEqual({ hooks: { state: { [KEY]: { trusted_hash: HASH } } } })
  })

  it('leaves no empty hooks.state, and no empty hooks, behind when everything was dropped', () => {
    const current = parsed(`model = "m"\n\n[hooks.state."${KEY}"]\ntrusted_hash = "sha256:old"\n`)
    expect(trustPatch(current, { trust: [], drop: () => true })).toEqual({ model: 'm' })
    const withOthers = parsed(`[hooks]\ntimeout = 3\n\n[hooks.state."${KEY}"]\ntrusted_hash = "sha256:old"\n`)
    expect(trustPatch(withOthers, { trust: [], drop: () => true })).toEqual({ hooks: { timeout: 3 } })
  })

  it('changes nothing when the hash is already trusted and nothing is dropped', () => {
    const toml = `model = "m"\n\n[hooks.state."${KEY}"]\ntrusted_hash = "${HASH}"\n\n[hooks.state."mine:a:0:0"]\ntrusted_hash = "sha256:aa"\n`
    const current = parsed(toml)
    const next = trustPatch(current, { trust: [{ key: KEY, hash: HASH }], drop: (k) => k.startsWith('gone@') })
    expect(same(next, current)).toBe(true)
    expect(same(trustPatch({}, { trust: [], drop: () => true }), {})).toBe(true)
    expect(same(trustPatch(parsed('model = "m"\n'), { trust: [], drop: () => true }), parsed('model = "m"\n'))).toBe(true)
  })

  it('does not change what it was given', () => {
    const current = parsed(`[hooks.state."mine:a:0:0"]\ntrusted_hash = "sha256:aa"\n`)
    const before = JSON.stringify(current)
    trustPatch(current, { trust: [{ key: KEY, hash: HASH }], drop: (k) => k === 'mine:a:0:0' })
    expect(JSON.stringify(current)).toBe(before)
  })

  describe('through config.toml', () => {
    const dirs: string[] = []
    afterEach(async () => {
      for (const d of dirs.splice(0)) await removeFixture(d)
    })

    // The patch is the value `hooks.state."<key>".trusted_hash`, Codex's own form of an account's trust. How the TOML patcher
    // spells it (a header, an inline table or a dotted key) is its choice; each of them parses to the same table.
    it('writes hooks.state."<key>".trusted_hash with the person\'s comments and tables untouched, and a second run writes nothing', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-codex-hooks-trust-'))
      dirs.push(dir)
      const file = path.join(dir, 'config.toml')
      const before = ['# my codex', 'model = "gpt-5" # the default', '', '[hooks.state."mine:a:0:0"]', 'trusted_hash = "sha256:aa"', '', '[mcp_servers.x]', 'command = "x"', ''].join('\n')
      await fs.writeFile(file, before, 'utf8')
      const patch = (c: Record<string, unknown>): Record<string, unknown> => trustPatch(c, { trust: [{ key: KEY, hash: HASH }], drop: never })
      expect(await patchTomlFile(file, patch, { throughLink: true })).toBe('written')
      const after = await fs.readFile(file, 'utf8')
      expect(after).toContain('# my codex')
      expect(after).toContain('model = "gpt-5" # the default')
      expect(after).toContain('[mcp_servers.x]')
      expect(after).toContain(KEY)
      expect(after).toContain(HASH)
      expect(readTomlObject(after)).toEqual(readTomlObject(`${before}\n[hooks.state."${KEY}"]\ntrusted_hash = "${HASH}"\n`))
      expect(await patchTomlFile(file, patch, { throughLink: true })).toBe('unchanged')
      expect(await fs.readFile(file, 'utf8')).toBe(after)
    })
  })
})

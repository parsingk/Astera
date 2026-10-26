// Observe mode, end to end on the Host (observe mode design §4, §5, §8, §10; plan Task 9): `policies set-mode --mode
// observe` through the CLI, then a Claude terminal session started through `sessions create` is spawned on the observe
// settings file, and the PostToolUse lines its audit capture would append are read by the Host's real audit watcher
// into records that `audit list` and `audit summary` read back with the starter rules' decisions. A Codex terminal
// session's rollout, found the way the Host finds one, gives its records the same way. In compatibility a session is
// spawned on the plain settings file and nothing it does is recorded. And what a worker's transcript says it spent is
// what `runs get` totals.
//
// **The CLI side is the real entry**, `main()` in run.ts, as src/host/agentProfiles.integration.test.ts runs it, with
// every variable that picks a Host, a caller or an agent (ASTERA_*, CLAUDE_*, CODEX_*) taken out for the call.
//
// **The Host side is the one index.ts builds for these calls**: a real `startHostServer` on the profile's own address,
// a real `createHostOrch` with the real policies and audit commands, the real session starter over the real
// `createHostSpawner`, and the recorder, its sources, the token store and the token sources made as index.ts makes them,
// before any pty opens. Only the pty spawn is fake, so no agent runs, and the sources' timers are not run: the test reads
// forward with their `poll`, as their timers would. Every hook line, rollout, statusline and transcript here is a
// synthetic fixture written as the capture or the provider would write it, never a person's own.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { main } from '../cli/run'
import { createHostSpawner } from './spawner'
import { createHostOrch } from './orch'
import { createHostSessionStarter } from './sessionCreate'
import { registrySessions } from './sessions'
import { hostAddress } from './address'
import { startHostServer, type HostServer } from './server'
import { hostFeatures } from './features'
import { PtyRegistry, type RegistryPty } from './registry'
import { ProcRegistry, type RegistryProc } from './procRegistry'
import { createHostPolicies } from './audit/policyCommands'
import { createHostAudit } from './audit/auditCommands'
import { createAuditRecorder, dispatchOfSession, registrySessionFacts } from './audit/recorder'
import { createAuditSources } from './audit/sources'
import { openTokenStore } from './tokens/store'
import { createTokenSources, tokenOwnerOf } from './tokens/sources'
import { readAuditPolicy } from '../core/audit/policy'
import { ensureHostKey } from '../core/host/hostKey'
import { HOST_PROTOCOL } from '../core/host/protocol'
import { readAccountEntries } from '../core/accounts/accountsFile'
import { AUDIT_HOOK_EVENTS, hookEventsDirIn, hookEventsFileIn } from '../core/hooks/sessionState'
import { HOOK_EVENT_AT } from '../core/hooks/eventTime'
import { defaultCwdProbe } from '../core/sessions/pathProbe'

const NOW = '2026-10-23T00:00:00.000Z'
const CLAUDE = 'acc_claude'
const CODEX = 'acc_codex'

let dir: string
let profile: string
let repo: string
let home: string
const cleanups: Array<() => Promise<void> | void> = []
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-observe-e2e-'))
  profile = path.join(dir, 'profile')
  repo = path.join(dir, 'repo')
  home = path.join(dir, 'home')
  for (const d of [profile, path.join(repo, 'src'), home, path.join(dir, 'skills'), path.join(dir, 'cfg-claude'), path.join(dir, 'cfg-codex')])
    await fs.mkdir(d, { recursive: true })
  await fs.writeFile(path.join(dir, 'Astera.exe'), '')
  await fs.writeFile(path.join(dir, 'cli.js'), '')
  // The settings migration done, as an app that ran once leaves it (the Host may answer orch calls)
  await fs.writeFile(path.join(profile, 'app-settings.json'), JSON.stringify({ orchAlwaysOnMigrated: true }))
  const acc = (id: string, cfg: string, provider: 'claude' | 'codex') => ({ id, label: id, configDir: path.join(dir, cfg), color: '#888', createdAt: NOW, provider })
  await fs.writeFile(path.join(profile, 'accounts.json'), JSON.stringify({ accounts: [acc(CLAUDE, 'cfg-claude', 'claude'), acc(CODEX, 'cfg-codex', 'codex')] }))
})
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

// ---------------------------------------------------------------------------------------------------
// The CLI, run through its real entry (as agentProfiles.integration.test.ts runs it).

class Exited extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`)
  }
}

/** One `astera …` invocation against the profile's Host. Every ASTERA_/CLAUDE_/CODEX_ variable of this process is out
 *  for the call (this suite may run inside an Astera session), and ASTERA_PROFILE_DIR names the rig's profile. */
async function astera(argv: string[]): Promise<{ code: number; data: Record<string, unknown>; out: string }> {
  const savedArgv = process.argv
  const savedEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(ASTERA_|CLAUDE_|CODEX_)/i.test(k)))
  let stdout = ''
  let stderr = ''
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write)
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  }) as typeof process.stderr.write)
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Exited(code ?? 0)
  }) as typeof process.exit)
  process.argv = [process.execPath, path.join('out', 'main', 'cli.js'), ...argv]
  for (const k of Object.keys(savedEnv)) delete process.env[k]
  process.env.ASTERA_PROFILE_DIR = profile
  let code: number
  try {
    await main()
    throw new Error(`astera ${argv.join(' ')} returned without an exit code`)
  } catch (e) {
    if (!(e instanceof Exited)) throw e
    code = e.code
  } finally {
    out.mockRestore()
    err.mockRestore()
    exit.mockRestore()
    process.argv = savedArgv
    delete process.env.ASTERA_PROFILE_DIR
    Object.assign(process.env, savedEnv)
  }
  const envelope = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as { ok: boolean; data?: Record<string, unknown> }
  expect(code, `astera ${argv.join(' ')} → ${stdout} ${stderr}`).toBe(0)
  expect(envelope.ok).toBe(true)
  return { code, data: envelope.data ?? {}, out: stdout }
}

// ---------------------------------------------------------------------------------------------------
// The Host.

type Spawned = { args: string[] | string; env: Record<string, string | undefined> }
/** The sources' timers are not run: every read forward is the test's `poll`. */
const noTick = (): (() => void) => () => {}

async function hostRig() {
  const spawned: Spawned[] = []
  const registry = new PtyRegistry({
    spawn: (_file, args, opts) => {
      const pty = { pid: 1000 + spawned.length, onData: () => {}, onExit: () => {}, write() {}, resize() {}, kill() {}, pause() {}, resume() {} }
      spawned.push({ args, env: opts.env })
      return pty as unknown as RegistryPty
    },
    log: () => {}
  })
  const procs = new ProcRegistry({ spawn: () => ({ pid: 1, onData: () => {}, onExit: () => {}, write() {}, kill() {} }) as unknown as RegistryProc, log: () => {} })
  const logs: string[] = []
  const log = (m: string): void => void logs.push(m)
  const readAccounts = () => readAccountEntries(path.join(profile, 'accounts.json'))
  const box: { orch: ReturnType<typeof createHostOrch> | null; server: HostServer | null } = { orch: null, server: null }
  // The spawner's environment is its own, with nothing of this process's agent variables in it
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, ASTERA_HOST_PROFILE_DIR: profile, ASTERA_HOST_CLI_EXEC: path.join(dir, 'Astera.exe'),
    ASTERA_HOST_CLI_ENTRY: path.join(dir, 'cli.js'), ASTERA_HOST_SKILLS: path.join(dir, 'skills')
  }
  const spawner = createHostSpawner({
    profileDir: profile, env, platform: process.platform, homeDir: home, registry, broadcast: () => {}, getState: () => box.orch!.state(), log,
    appKeepsWorktrees: () => false,
    // A Codex session's rollout is looked for on its account's folder as index.ts looks, only more often
    locatePollMs: 20,
    worktrees: { fork: () => Promise.reject(new Error('not in this test')), makeRunWorktree: async () => { throw new Error('no') }, mergeWorktrees: async () => { throw new Error('no') }, removeWorktrees: async () => { throw new Error('no') } }
  })!

  // As index.ts makes them, before any pty opens: the token store, the recorder reading the mode from
  // audit-policy.json, its sources over the two registries and the profile's hook-events folder, and the token sources
  const tokenStore = await openTokenStore({ profileDir: profile, state: () => (box.orch?.loaded() ? box.orch.state() : null), log })
  const recorder = createAuditRecorder({
    profileDir: profile,
    mode: async () => (await readAuditPolicy(profile, { keepDamaged: false }))?.mode ?? 'compatibility',
    sessionInfo: registrySessionFacts({ ptys: registry, procs }),
    dispatchOf: (sessionId, at) => dispatchOfSession(box.orch!.state(), sessionId, at),
    log
  })
  const auditSources = createAuditSources({ recorder, ptys: registry, procs, hookEventsDir: hookEventsDirIn(profile), log, every: noTick })
  const tokenSources = createTokenSources({
    store: tokenStore,
    ptys: registry,
    procs,
    statusLinePayload: (sid) => spawner.statusLinePayload(sid),
    ownerOf: (sessionId, at, last) => tokenOwnerOf(box.orch!.state(), sessionId, at, last),
    log,
    every: noTick
  })

  const hostSessions = registrySessions({ ptys: registry, procs, hookEventsDir: hookEventsDirIn(profile), accounts: readAccounts })
  const orch = createHostOrch({
    profileDir: profile,
    version: '9.9.9',
    // A change of the rules or the mode tells the recorder, as index.ts wires it
    policies: createHostPolicies({ profileDir: profile, onChange: () => recorder.invalidate() }),
    audit: createHostAudit({ profileDir: profile }),
    spentTokens: () => tokenStore.spent(),
    now: () => new Date().toISOString(),
    hostStartedAt: () => box.server!.startedAt,
    runningSessions: () => registry.liveCount() + procs.liveCount(),
    aliveSessionIds: () => new Set(registry.list().filter((e) => e.alive && e.meta?.kind === 'session').map((e) => e.meta!.id)),
    act: (name, args) => box.server!.act(name, args),
    hasApp: () => box.server!.hasApp(),
    onState: () => {},
    log,
    sessions: hostSessions,
    createSession: createHostSessionStarter({
      spawner,
      chats: null,
      rolling: null,
      readAccounts,
      bypass: async () => false,
      profileDir: profile,
      probeCwd: defaultCwdProbe,
      announceProc: () => {},
      list: () => hostSessions.listSessions(),
      ptyOf: (id) => registry.sessionPty(id),
      log
    }),
    local: spawner
  })
  box.orch = orch
  const addr = hostAddress({ profileDir: profile, platform: process.platform, tmpDir: os.tmpdir(), protocol: HOST_PROTOCOL })
  const server = await startHostServer({
    address: addr.address,
    dirToPrepare: addr.dirToPrepare,
    version: '9.9.9',
    idleMs: 120_000,
    onIdle: () => {},
    hostKey: await ensureHostKey(profile),
    liveCounts: () => ({ sessions: registry.liveCount() + procs.liveCount(), runs: orch.runningRuns() }),
    orch,
    features: hostFeatures({ spawns: true, slack: false }),
    log: { write: log, close: () => {} }
  })
  box.server = server
  cleanups.push(async () => {
    auditSources.dispose()
    tokenSources.dispose()
    await recorder.flushed()
    await spawner.closeAndSettle(0)
    await server.close().catch(() => {})
    registry.killAll()
    if (addr.dirToPrepare) await fs.rm(addr.dirToPrepare, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })

  /** Starts a terminal session through the CLI; answers its id and what was spawned for it. */
  const createSession = async (account: string): Promise<{ id: string; spawn: Spawned }> => {
    const created = await astera(['sessions', 'create', '--account', account, '--cwd', repo])
    expect(spawned.length).toBeGreaterThan(0)
    return { id: created.data.id as string, spawn: spawned[spawned.length - 1] }
  }
  /** The note the Host keeps for a session's pty. */
  const restoreOf = (sessionId: string): Record<string, unknown> =>
    registry.list().find((e) => e.meta?.kind === 'session' && e.meta.id === sessionId)!.meta!.restore
  /** Reads every source forward once, as their timers would, and waits for what the recorder was handed to land. */
  const settle = async (): Promise<void> => {
    await auditSources.poll()
    await recorder.flushed()
  }
  /** Quiet: every source read forward and nothing new kept, for a few turns in a row. For the assertions that a call
   *  was **not** recorded, where there is no record to wait for: a line the folder watch is already reading when a
   *  poll runs is passed by that poll and kept a moment after it (measured: 5 ms), so one `settle` would pass over
   *  it. Bounded like every wait. */
  const quiet = async (): Promise<void> => {
    const folder = path.join(profile, 'audit')
    const mark = async (): Promise<string> => {
      const names = await fs.readdir(folder).catch(() => [] as string[])
      return JSON.stringify(await Promise.all(names.map(async (n) => [n, (await fs.stat(path.join(folder, n))).size])))
    }
    let last = await mark()
    let still = 0
    await vi.waitFor(
      async () => {
        await settle()
        await new Promise((r) => setTimeout(r, 15))
        const now = await mark()
        still = now === last ? still + 1 : 0
        last = now
        expect(still).toBeGreaterThanOrEqual(8)
      },
      { timeout: 20_000, interval: 1 }
    )
  }
  return { spawned, createSession, restoreOf, settle, quiet, recorder, tokenSources, logs }
}

const line = (s: Spawned) => (Array.isArray(s.args) ? s.args.join(' ') : s.args)
/** The settings file a Claude session was spawned on (`--settings`), as a native path. */
const settingsOf = (s: Spawned): string => {
  const file = /--settings\s+"?([^"\s]+\.json)/.exec(line(s))?.[1]
  expect(file, line(s)).toBeDefined()
  return path.normalize(file!)
}
const PLAIN = /[\\/]astera-(statusline|hooks)-settings\.json$/
const OBSERVE = /[\\/]astera-observe-(hooks-)?settings\.json$/
/** Whether any observe file was ever written into the profile. */
const observeFiles = (): string[] =>
  ['astera-observe-settings.json', 'astera-observe-hooks-settings.json', 'astera-hook-audit-capture.cjs'].filter((f) => existsSync(path.join(profile, f)))

/** The audit file an observed session's capture appends to: its own hook file's name with `.audit.jsonl`, derived from
 *  ASTERA_HOOK_OUT as the capture derives it (statusline.ts HOOK_AUDIT_CAPTURE_SCRIPT). */
const auditFileOf = (s: Spawned): string => s.env.ASTERA_HOOK_OUT!.slice(0, -'.jsonl'.length) + AUDIT_HOOK_EVENTS
/** A PostToolUse line as the audit capture writes it: the stamp and what names the call, nothing of its output. */
const postToolUse = (tool: string, input: unknown, id: string) =>
  JSON.stringify({ [HOOK_EVENT_AT]: Date.now(), hook_event_name: 'PostToolUse', tool_name: tool, tool_input: input, tool_use_id: id }) + '\n'
const appendLines = async (file: string, text: string): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, text)
}

/** A Codex rollout as codex writes one for a session in `repo`, under the account's sessions/<y>/<m>/<d> folder of
 *  today, where the Host's locate looks: its session_meta line, then the call lines `calls` gives. */
async function writeRollout(calls: (at: string) => Array<{ type: string; payload: Record<string, unknown> }>): Promise<string> {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const folder = path.join(dir, 'cfg-codex', 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()))
  await fs.mkdir(folder, { recursive: true })
  const id = randomUUID()
  const file = path.join(folder, `rollout-${d.toISOString().slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`)
  const at = new Date().toISOString()
  const rows = [
    { timestamp: at, type: 'session_meta', payload: { id, timestamp: at, cwd: repo, originator: 'codex_cli_rs', cli_version: '0.160.0', source: 'cli' } },
    ...calls(at).map((c) => ({ timestamp: at, ...c }))
  ]
  await fs.writeFile(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return file
}
/** A shell exec of `git push`, an apply_patch inside the project and an MCP call, as codex 0.160 writes them. */
const CODEX_CALLS = (): Array<{ type: string; payload: Record<string, unknown> }> => [
  {
    type: 'response_item',
    payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'git push origin main', workdir: repo }), call_id: 'call_push' }
  },
  {
    type: 'response_item',
    payload: { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch\n', call_id: 'call_patch', status: 'completed' }
  },
  // What Codex writes when they are over: the exec's exit code, and the patch's result
  { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_push', output: 'Exit code: 0\nWall time: 0.1 seconds\nOutput:\n' } },
  { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_patch', output: [{ type: 'input_text', text: 'Success. Updated the following files:\nM src/a.ts' }] } },
  {
    type: 'event_msg',
    payload: { type: 'mcp_tool_call_end', call_id: 'call_mcp', invocation: { server: 'linear', tool: 'get_issue', arguments: { id: 'LIN-1' } }, result: { Ok: { content: [], isError: false } } }
  }
]

type Listed = { records: Array<Record<string, unknown> & { id: string; decision: string; action: string; target: string }> }
const auditList = async (argv: string[] = []): Promise<Listed> => (await astera(['audit', 'list', ...argv])).data as unknown as Listed
const brief = (r: Listed['records'][number]) => ({ action: r.action, target: r.target, decision: r.decision, ...(r.ruleId !== undefined ? { ruleId: r.ruleId } : {}) })
const byAction = (a: { action: string }, b: { action: string }): number => a.action.localeCompare(b.action)

describe('observe mode on the Host, end to end through the CLI', { timeout: 60_000 }, () => {
  it('observe on: a Claude session is spawned on the observe settings, and its PostToolUse lines are records audit list and audit summary read with their decisions', async () => {
    const h = await hostRig()
    expect((await astera(['policies', 'set-mode', '--mode', 'observe'])).data.mode).toBe('observe')

    const s = await h.createSession(CLAUDE)
    // Spawned on an observe settings file, which adds the audit capture for every tool, without waiting on it
    const settings = settingsOf(s.spawn)
    expect(settings).toMatch(OBSERVE)
    expect(path.dirname(settings)).toBe(path.normalize(profile))
    const hooks = (JSON.parse(await fs.readFile(settings, 'utf8')) as { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; async?: boolean }> }>> }).hooks
    for (const event of ['PostToolUse', 'PostToolUseFailure'])
      expect(hooks[event]).toContainEqual({ matcher: '*', hooks: [expect.objectContaining({ command: expect.stringContaining('astera-hook-audit-capture.cjs'), async: true })] })
    expect(h.restoreOf(s.id)).toMatchObject({ observed: true, accountId: CLAUDE })
    expect(s.spawn.env.ASTERA_HOOK_OUT).toBe(hookEventsFileIn(hookEventsDirIn(profile), s.id))

    // What the capture appends after a `git push origin main` in Bash and a Read inside the project
    await appendLines(
      auditFileOf(s.spawn),
      postToolUse('Bash', { command: 'git push origin main', description: 'push the fix' }, 'toolu_push') +
        postToolUse('Read', { file_path: path.join(repo, 'src', 'a.ts') }, 'toolu_read')
    )
    await vi.waitFor(
      async () => {
        await h.settle()
        expect((await auditList()).records).toHaveLength(2)
      },
      { timeout: 20_000, interval: 50 }
    )

    const listed = (await auditList()).records
    expect(listed.map(brief).sort(byAction)).toEqual([
      { action: 'filesystem.read', target: 'src/a.ts', decision: 'allow' },
      { action: 'git.remote.write', target: 'git push', decision: 'would-deny', ruleId: 'starter-git-remote-write' }
    ])
    for (const r of listed) expect(r).toMatchObject({ sessionId: s.id, accountId: CLAUDE, provider: 'claude', kind: 'terminal', source: 'claude-hook', status: 'ok' })
    expect((await auditList(['--decision', 'would-deny'])).records.map((r) => r.providerTool)).toEqual(['Bash'])
    expect((await auditList(['--session', s.id])).records).toHaveLength(2)

    expect((await astera(['audit', 'summary'])).data).toEqual({
      allow: 1,
      wouldDeny: 1,
      unknown: 0,
      byAction: { 'git.remote.write': { allow: 0, wouldDeny: 1, unknown: 0 }, 'filesystem.read': { allow: 1, wouldDeny: 0, unknown: 0 } },
      stoppedAtLimit: false
    })

    // A record keeps the action and a short target: nothing of the rest of the command or of its description
    const kept = (await Promise.all((await fs.readdir(path.join(profile, 'audit'))).map((f) => fs.readFile(path.join(profile, 'audit', f), 'utf8')))).join('')
    expect(kept).not.toMatch(/origin|push the fix/)
  })

  it('observe on: a Codex session’s rollout, found as the Host finds it, gives a record for a shell push, an apply_patch and an MCP call', async () => {
    const h = await hostRig()
    await astera(['policies', 'set-mode', '--mode', 'observe'])

    const s = await h.createSession(CODEX)
    // A Codex session has no settings file to be given; its note says it was started observed
    expect(line(s.spawn)).not.toMatch(/--settings/)
    expect(h.restoreOf(s.id)).toMatchObject({ observed: true, accountId: CODEX })

    const file = await writeRollout(CODEX_CALLS)
    // The Host's locate maps the rollout into the session's note, which is where its source learns of it
    await vi.waitFor(() => expect(path.normalize(String(h.restoreOf(s.id).rolloutPath))).toBe(path.normalize(file)), { timeout: 20_000, interval: 20 })
    await vi.waitFor(
      async () => {
        await h.settle()
        expect((await auditList()).records).toHaveLength(3)
      },
      { timeout: 20_000, interval: 50 }
    )

    const listed = (await auditList()).records
    expect(listed.map(brief).sort(byAction)).toEqual([
      { action: 'filesystem.write', target: 'src/a.ts', decision: 'allow' },
      { action: 'git.remote.write', target: 'git push', decision: 'would-deny', ruleId: 'starter-git-remote-write' },
      { action: 'mcp.call', target: 'linear.get_issue', decision: 'allow' }
    ])
    for (const r of listed) expect(r).toMatchObject({ sessionId: s.id, accountId: CODEX, provider: 'codex', kind: 'terminal', source: 'codex-rollout' })
    // The calls Codex wrote an output for are told how they went; the MCP end event says it itself
    expect(listed.map((r) => r.status)).toEqual(['ok', 'ok', 'ok'])
    expect((await astera(['audit', 'summary'])).data).toMatchObject({ allow: 2, wouldDeny: 1, unknown: 0 })

    // Read again, nothing is recorded twice
    await h.quiet()
    expect((await auditList()).records).toHaveLength(3)
  })

  it('compatibility: sessions are spawned on the plain settings, no observe file is written, and the same calls make no record', async () => {
    const h = await hostRig()
    expect((await astera(['policies', 'show'])).data.mode).toBe('compatibility')

    const claude = await h.createSession(CLAUDE)
    const codex = await h.createSession(CODEX)
    expect(settingsOf(claude.spawn)).toMatch(PLAIN)
    const plain = JSON.parse(await fs.readFile(settingsOf(claude.spawn), 'utf8')) as { hooks: Record<string, unknown> }
    expect(plain.hooks).not.toHaveProperty('PostToolUseFailure')
    expect(JSON.stringify(plain)).not.toMatch(/astera-hook-audit-capture/)
    for (const s of [claude, codex]) expect(h.restoreOf(s.id)).not.toHaveProperty('observed')
    expect(observeFiles()).toEqual([])

    // The same calls as above: the Claude ones in the audit file and in the session's own file, the Codex ones in a
    // rollout its note names
    const calls = postToolUse('Bash', { command: 'git push origin main' }, 'toolu_push') + postToolUse('Read', { file_path: path.join(repo, 'src', 'a.ts') }, 'toolu_read')
    await appendLines(auditFileOf(claude.spawn), calls)
    await appendLines(claude.spawn.env.ASTERA_HOOK_OUT!, calls)
    const file = await writeRollout(CODEX_CALLS)
    await vi.waitFor(() => expect(path.normalize(String(h.restoreOf(codex.id).rolloutPath))).toBe(path.normalize(file)), { timeout: 20_000, interval: 20 })
    await h.quiet()

    expect((await auditList()).records).toEqual([])
    expect((await astera(['audit', 'summary'])).data).toMatchObject({ allow: 0, wouldDeny: 0, unknown: 0, byAction: {} })
    // Nothing new in the profile: no records folder, no rules file, no observe files
    expect(existsSync(path.join(profile, 'audit'))).toBe(false)
    expect(existsSync(path.join(profile, 'audit-policy.json'))).toBe(false)
    expect(observeFiles()).toEqual([])
  })

  it('back to compatibility: a new session is spawned on the plain settings again, and what an observed session does next is not recorded', async () => {
    const h = await hostRig()
    await astera(['policies', 'set-mode', '--mode', 'observe'])
    const observed = await h.createSession(CLAUDE)
    expect(settingsOf(observed.spawn)).toMatch(OBSERVE)
    // The control: while observing, its call is a record
    await appendLines(auditFileOf(observed.spawn), postToolUse('Bash', { command: 'git push origin main' }, 'toolu_1'))
    await vi.waitFor(
      async () => {
        await h.settle()
        expect((await auditList()).records).toHaveLength(1)
      },
      { timeout: 20_000, interval: 50 }
    )

    expect((await astera(['policies', 'set-mode', '--mode', 'compatibility'])).data.mode).toBe('compatibility')
    // The recorder reads the mode again at the change; the sources then stop reading
    await h.settle()
    const after = await h.createSession(CLAUDE)
    expect(settingsOf(after.spawn)).toMatch(PLAIN)
    expect(h.restoreOf(after.id)).not.toHaveProperty('observed')

    // The equivalent calls of both sessions now: the observed one's capture still appends (its settings were read at its
    // start), and the new one is given the same lines
    await appendLines(auditFileOf(observed.spawn), postToolUse('Bash', { command: 'git push origin main' }, 'toolu_2'))
    await appendLines(auditFileOf(after.spawn), postToolUse('Bash', { command: 'git push origin main' }, 'toolu_3'))
    await h.quiet()
    expect((await auditList()).records.map((r) => r.sessionId)).toEqual([observed.id])
  })

  it('token totals: what a worker’s transcript says its two responses used is the tokens runs get and tasks-get show', async () => {
    const h = await hostRig()
    const job = (await astera(['jobs', 'create', '--objective', 'count the tokens', '--cwd', repo, '--concurrency', '1'])).data
    await astera(['tasks', 'add', '--job', job.id as string, '--title', 'one', '--spec', 'do the one thing', '--account', CLAUDE])
    const run = (await astera(['jobs', 'run', '--id', job.id as string])).data
    // The Run's own Task, which the Job's was copied into; this rig's Host places no worker by itself, so it is placed here
    const task = ((await astera(['tasks', 'list', '--run', run.id as string])).data.tasks as Array<Record<string, unknown>>)[0]
    const worker = (await astera(['worker-start', '--task', task.id as string, '--agent', 'claude', '--account', CLAUDE, '--worktree', 'current'])).data
    const sessionId = worker.sessionId as string
    const spawn = h.spawned[h.spawned.length - 1]
    expect(spawn.env.ASTERA_SESSION).toBe(sessionId)

    // What the worker's statusline capture writes (it names the transcript), and the transcript Claude writes: two
    // responses, the first in two lines as Claude writes a message per content block, and a person's line between
    const transcript = path.join(dir, 'transcripts', 'worker.jsonl')
    await appendLines(spawn.env.ASTERA_STATUSLINE_OUT!, JSON.stringify({ session_id: randomUUID(), transcript_path: transcript }))
    const at = new Date().toISOString()
    const assistant = (id: string, usage: Record<string, number>, text: string) =>
      JSON.stringify({ type: 'assistant', timestamp: at, message: { id, role: 'assistant', content: [{ type: 'text', text }], usage } })
    const first = { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 }
    await appendLines(
      transcript,
      [
        JSON.stringify({ type: 'user', timestamp: at, message: { role: 'user', content: 'go' } }),
        assistant('msg_1', first, 'a'),
        assistant('msg_1', first, 'b'),
        assistant('msg_2', { input_tokens: 200, output_tokens: 60 }, 'c')
      ].join('\n') + '\n'
    )
    await h.tokenSources.poll()

    const tokens = { input: 350, output: 100, total: 450 }
    const got = (await astera(['runs', 'get', '--id', run.id as string])).data
    expect(got.tokens).toEqual(tokens)
    expect(got).not.toHaveProperty('coordinatorTokens')
    expect((await astera(['tasks-get', '--id', task.id as string])).data.tokens).toEqual(tokens)
    // Kept in every mode: this profile never turned observe on, and the totals are in the profile
    expect(existsSync(path.join(profile, 'audit-policy.json'))).toBe(false)
    expect(JSON.parse(await fs.readFile(path.join(profile, 'token-totals.json'), 'utf8'))).toMatchObject({
      spent: [{ sessionId, dispatchId: worker.dispatchId, input: 350, output: 100 }]
    })
  })
})

// The rig above builds what index.ts builds; index.ts itself never runs in a test, so the four places where observe mode
// is wired into the Host are guarded by its text (as the plugin manager's wiring is, plugins/commands.test.ts)
describe('index.ts wires observe mode into the Host', () => {
  it('makes the sources, re-reads the mode when the policies change it, and hands the orch the spent tokens', async () => {
    const { fileURLToPath } = await import('node:url')
    const src = await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8')
    for (const wiring of ['createAuditSources({', 'createTokenSources({', 'onChange: (cmd) => auditRecorder.invalidate(', 'spentTokens: () => tokenStore.spent()'])
      expect(src, wiring).toContain(wiring)
  })
})

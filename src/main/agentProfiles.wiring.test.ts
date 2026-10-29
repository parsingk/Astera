// Agent Profiles design §5: the app's spawn paths resolve the profile a spawn names (a name to its id, one that does not
// resolve dropped) with profileSpawn (appProfileSpawn for a person's spawn), whose rules core/agentProfiles/permission.test.ts pins, then hand the id to the
// capability refresh and the spawn, and stamp the profile's use after it. registerIpc cannot run without Electron, so the
// wiring is guarded by its text, as agentSessions.wiring.test.ts guards who started a session.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SpawnChecks } from '../core/sessions/manager'
import type { ChatManagerDeps } from '../core/chat/manager'
import type { claudeSandboxStart } from '../core/sandbox/claudeStart'
import type { HostChatsDeps } from '../host/hostChats'
import type { HostSpawner } from '../host/spawner'

// Task E fix round 6 (re-review 2, Minor 3): every place a sandboxed start is wired must say how links on the paths it
// names are looked at (nodeLinkLook, or null where paths are named as given on purpose). Left optional, a new wiring that
// forgot it would drop E5's link refusals and the Linux warning without a word; required, it does not compile. Checked
// by tsc: each line below is an error only while the field is required
describe('a start cannot be wired without saying how links are looked at', () => {
  it('the terminal checks, the chat deps, a Claude start, the Host chats and the Host spawner all require it', () => {
    // @ts-expect-error linkLook is required
    const checks: Pick<SpawnChecks, 'linkLook'> = {}
    // @ts-expect-error linkLook is required
    const chat: Pick<ChatManagerDeps, 'linkLook'> = {}
    // @ts-expect-error linkLook is required
    const claude: Pick<Parameters<typeof claudeSandboxStart>[0], 'linkLook'> = {}
    // @ts-expect-error linkLook is required
    const hostChats: Pick<HostChatsDeps, 'linkLook'> = {}
    // @ts-expect-error linkLook is required
    const spawner: Pick<HostSpawner, 'linkLook'> = {}
    expect([checks, chat, claude, hostChats, spawner]).toHaveLength(5)
  })
})

const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ipc.ts'), 'utf8')
const between = (from: string, to: string): string => {
  const start = src.indexOf(from)
  const end = src.indexOf(to, start)
  if (start < 0 || end < 0) throw new Error(`not found: ${from} … ${to}`)
  return src.slice(start, end)
}
const before = (text: string, a: string | RegExp, b: string | RegExp): boolean => {
  const i = typeof a === 'string' ? text.indexOf(a) : text.search(a)
  const j = typeof b === 'string' ? text.indexOf(b) : text.search(b)
  return i >= 0 && j >= 0 && i < j
}

describe('ipc.ts starts a session from an agent profile', () => {
  const body = between('  async function spawnSession(opts: any)', "ipcMain.handle('sessions.spawn'")
  const chat = between("    if (opts.kind === 'chat') {", '      return chatInfo')
  const terminal = body.slice(body.indexOf('      return chatInfo'))

  // Task 8 fix round 1: an unresolved profile drops its id but not the bypass, which falls back to the app-wide mode
  // (appProfileSpawn, pinned in permission.test.ts): the dialog sent none with the profile picked
  it('resolves the profile, an unresolved one falling back to the app-wide mode, before the chat fork and the terminal prepare', () => {
    expect(body).toMatch(/const resolved = await appProfileSpawn\(/)
    expect(body).toMatch(/opts = \{ \.\.\.rest, \.\.\.resolved \}/)
    expect(before(body, 'appProfileSpawn(', "if (opts.kind === 'chat')")).toBe(true)
  })

  it('a chat session: the capability refresh and the spawn take the profile, and its use is stamped', () => {
    expect(chat).toMatch(/core\.capabilities\.refresh\(account, opts\.agentProfileId\)/)
    expect(chat).toMatch(/agentProfileId: opts\.agentProfileId/)
    expect(before(chat, 'core.chat.spawn(', 'touchAgentProfile(opts.agentProfileId)')).toBe(true)
  })

  // Sandbox design §6: the profile's switch rides the resolved options (appProfileSpawn, pinned in permission.test.ts), so
  // the prepare reads the folder for it and the spawn, which takes `...opts`, starts in it
  it('a terminal session: the prepare takes the profile and its sandbox, the spawn carries them in opts, and its use is stamped after', () => {
    expect(terminal).toMatch(
      /core\.sessions\.prepare\(\{ account, cwd: opts\.cwd, \.\.\.\(opts\.agentProfileId !== undefined \? \{ agentProfileId: opts\.agentProfileId \} : \{\}\), \.\.\.\(opts\.sandbox === true \? \{ sandbox: true \} : \{\}\) \}\)/
    )
    expect(terminal).toMatch(/core\.sessions\.spawn\(\{\s*\.\.\.opts,/)
    expect(before(terminal, 'core.sessions.spawn({', 'touchAgentProfile(opts.agentProfileId)')).toBe(true)
  })

  // Task 5 fix round 1: a profile store that cannot be read refuses the start (profileSpawn rethrows its RepairNeeded,
  // pinned in permission.test.ts); nothing on the app's two paths may catch it and start without the profile
  it('a profile store that cannot be read refuses the spawn: neither the person’s path nor a worker’s catches it', () => {
    const resolving = between('const resolved = await appProfileSpawn(', 'opts = { ...rest, ...resolved }')
    expect(resolving).not.toMatch(/\.catch\(|try \{/)
    expect(body.slice(0, body.indexOf('const resolved = await appProfileSpawn('))).not.toMatch(/if \(opts\.agentProfileId !== undefined\) \{\s*try \{/)
    const worker = between('      spawnSession: async (o) => {', 'const info = await spawnSession(')
    expect(worker).toMatch(/const profile = await profileSpawn\(/)
    expect(worker).not.toMatch(/\.catch\(|try \{/)
  })

  it('stamps through the Host, never awaited', () => {
    expect(between('  const touchAgentProfile = ', '\n  }')).toMatch(/void orchCall\(\{ cmd: 'agent-profiles-touch', args: \{ id \}, sessionId: '' \}\)\.catch\(/)
  })

  it('a Job’s worker: the profile decides the bypass before the app-wide mode fills it, and its real id is passed', () => {
    const worker = between('      spawnSession: async (o) => {', "send('session:created', info)")
    expect(before(worker, 'profileSpawn(', 'const info = await spawnSession(')).toBe(true)
    expect(worker).toMatch(/profile\?\.bypassPermissions \?\? o\.bypassPermissions \?\? core\.appSettings\.getAgentPermissionMode\(\) === 'yolo'/)
    expect(worker).toMatch(/\.\.\.\(profile \? \{ agentProfileId: profile\.agentProfileId \} : \{\}\)/)
  })
})

// Agent Profiles design §7: a roll keeps the profile. The coordinators hand the chain's profile id to prepareSpawn (their
// own tests pin that), and index.ts's two coordinators must pass it on to the prepare that warms the capabilities. The
// sandbox (sandbox design §6) rides beside it, so the folder is read for the sandbox before the kill.
describe('index.ts prepares a roll on the chain’s agent profile', () => {
  const index = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8')

  it('both coordinators’ prepareSpawn pass the profile id and the sandbox to the prepare', () => {
    expect(index.split('\n').filter((l) => l.includes('prepareSpawn:'))).toHaveLength(2)
    const shared = String.raw`core!\.sessions\.prepare\(\{ account, cwd, \.\.\.\(agentProfileId \? \{ agentProfileId \} : \{\}\), \.\.\.\(sandbox \? \{ sandbox: true \} : \{\}\)`
    // The claude coordinator's, as it was
    expect(index).toMatch(new RegExp(String.raw`prepareSpawn: \(account, cwd, agentProfileId, sandbox\) => ${shared} \}\)`))
    // Task 6 fix round 1: the codex coordinator's also says when the respawn is a chat's (its sandbox needs no
    // --no-daemon)
    expect(index).toMatch(
      new RegExp(String.raw`prepareSpawn: \(account, cwd, agentProfileId, sandbox, kind\) =>\s+${shared}, \.\.\.\(kind === 'chat' \? \{ chat: true \} : \{\}\) \}\)`)
    )
  })

  // Task 7 fix round 1: a refused roll says why in the tab or the pane, from either coordinator, through the one `tell`
  it('both coordinators are handed the same tell for a refused roll', () => {
    const claude = index.slice(index.indexOf('  const rolling = new RollingCoordinator({'), index.indexOf('  const codexRolling = new CodexRollingCoordinator({'))
    const codex = index.slice(index.indexOf('  const codexRolling = new CodexRollingCoordinator({'))
    expect(claude).toMatch(/\n    tell: tellRollRefusal,/)
    expect(codex).toMatch(/\n    tell: tellRollRefusal,/)
  })
})

// Agent Profiles design §6, Task 6 fix round 1 (I2): the app answers its own UI's run-create and task-create, so its orch
// deps read the profile store, from the same folder its spawns resolve profiles from. The deps are built inside
// registerIpc, so the wiring is guarded by its text; core/orchestration/command.test.ts runs task-create over the same
// reader on a real file.
describe('ipc.ts answers a Job or Task made from an agent profile', () => {
  it('its orch deps read the profile store of the app’s own profile folder', () => {
    const deps = between('    const deps: OrchServerDeps = {', '      listAccounts: (provider, opts) =>')
    expect(deps).toMatch(/readAgentProfiles: \(\) => readAgentProfiles\(app\.getPath\('userData'\)\)/)
    expect(src).toMatch(/import \{ readAgentProfiles \} from '\.\.\/core\/agentProfiles\/store'/)
  })
})

// Follow-up: a history resume of a conversation no tab holds starts as the profile that ran it. The app writes the
// profile down by the conversation's own id when one of its sessions learns that id (core/agentProfiles/conversations.ts
// pins the store); the three places the id is learned and the reader the resume dialog asks are built inside
// createCore, registerIpc and index.ts's whenReady, so they are guarded by their text.
describe('the app records the conversation a profiled session is on, and reads it back for a history resume', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const index = readFileSync(path.join(here, 'index.ts'), 'utf8')
  const core = readFileSync(path.join(here, 'core.ts'), 'utf8')

  it('core builds the recorder over the app’s own profile folder, asking both managers for a session’s profile', () => {
    expect(core).toMatch(/profileConversations\(\{\s*profileDir: userDataDir,/)
    expect(core).toMatch(/profileOfSession: \(id\) => sessions\.list\(\)\.find\(\(s\) => s\.id === id\)\?\.agentProfileId \?\? chat\.info\(id\)\?\.agentProfileId/)
  })

  // After the fan-out, so it can never cost the attention, prompt and Slack taps their turn
  it('a Claude terminal session learns it from every hook payload, after the fan-out', () => {
    const hook = index.slice(index.indexOf('const hookWatcher = new HookEventWatcher('), index.indexOf('hookWatcher.start()'))
    expect(hook).toMatch(/void core!\.profileConversations\.learned\(sessionId, extractStatusLineSession\(payload\)\.sessionId\)/)
    expect(before(hook, 'fanOutHookEvent(', 'profileConversations.learned(')).toBe(true)
  })

  it('a Codex terminal session learns it from the thread its rollout scan maps', () => {
    const remember = index.slice(index.indexOf('    remember: (sessionId, note) => {'), index.indexOf('codexRolloutRef = codexRollout'))
    expect(remember).toMatch(/void core!\.profileConversations\.learned\(sessionId, note\.codexSessionId\)/)
  })

  it('a chat session learns it from its ready', () => {
    const ready = between("    if (event.type === 'ready') {", '      const provider = core.chat.state(sessionId)?.provider')
    expect(ready).toMatch(/void core\.profileConversations\.learned\(sessionId, event\.threadId\)/)
  })

  it('a resume names it at the spawn, recorded once the profile is resolved', () => {
    const body = between('  async function spawnSession(opts: any)', "ipcMain.handle('sessions.spawn'")
    expect(body).toMatch(/if \(resumeId && opts\.agentProfileId !== undefined\) void core\.profileConversations\.record\(resumeId, opts\.agentProfileId\)/)
    expect(before(body, 'opts = { ...rest, ...resolved }', 'core.profileConversations.record(resumeId')).toBe(true)
  })

  it('the resume dialog’s defaults carry the profile it ran as', () => {
    const defaults = between("ipcMain.handle('sessions.resumeDefaults'", '\n  }))')
    expect(defaults).toMatch(/agentProfileId: await core\.profileConversations\.profileOf\(sessionId\)/)
  })
})

// Final fix pass (minor 1, C3): the sandbox comes from the profile, never from the options a caller passes (a `sandbox`
// the renderer sends is dropped), and the app's own start of a sandboxed session's work asks for it apart
// (`forceSandbox`), refused where the CLI has no sandbox. registerIpc cannot run without Electron: guarded by its text
describe('ipc.ts takes the sandbox from the profile, or from a sandboxed session’s work', () => {
  const body = between('  async function spawnSession(opts: any)', "ipcMain.handle('sessions.spawn'")
  it('drops a caller’s sandbox before the profile is read, and refuses a forced one where the CLI has none', () => {
    // Task K fix round 1: a reviewer's allowance of deny rules only is dropped with them, never taken from the caller
    expect(body).toMatch(/const \{ sandbox: _callerSandbox, forceSandbox: _forced, forceSandboxDenyOnly: _denyOnly, \.\.\.withoutSandbox \} = opts/)
    expect(before(body, 'withoutSandbox', 'appProfileSpawn(')).toBe(true)
    expect(body).toMatch(/forcedSandboxBlocker\(providerOf\(account\), process\.platform\)/)
    expect(body).toMatch(/if \(forceSandbox\) opts = \{ \.\.\.opts, sandbox: true \}/)
  })
  it('the renderer cannot ask for a forced one', () => {
    expect(src).toMatch(/ipcMain\.handle\('sessions\.spawn', async \(_e, opts\) => spawnSession\(\{ \.\.\.opts, forceSandbox: undefined, forceSandboxDenyOnly: undefined \}\)\)/)
  })
  it('a worker and a coordinator of a sandboxed session’s work are started with forceSandbox', () => {
    const worker = between('      spawnSession: async (o) => {', "send('session:created', info)")
    expect(worker).toMatch(/\.\.\.\(o\.sandbox \? \{ forceSandbox: true \} : \{\}\)/)
    const coord = between('      startCoordinator: (a) =>', '      stopCoordinator:')
    expect(coord).toMatch(/\.\.\.\(sandbox \? \{ forceSandbox: true \} : \{\}\)/)
  })
})

// Task E (2026-10-28, fix round 1): a sandboxed session keeps read-only the profile folder and every place Astera writes
// code or an installer to and runs unsandboxed. core.ts builds that list once (sandboxReadOnly) and hands it to the
// Claude twins and both managers. createCore cannot run without Electron: guarded by its text
describe('core.ts builds the read-only list once and hands it to the twins and both managers', () => {
  const core = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'core.ts'), 'utf8')
  it('builds the list with sandboxReadOnly from the profile, runtime, updater cache, install root and junction', () => {
    const built = core.slice(core.indexOf('const readOnly = sandboxReadOnly({'), core.indexOf('\n  })', core.indexOf('const readOnly = sandboxReadOnly({')))
    expect(built).toMatch(/profileDir: userDataDir/)
    expect(built).toMatch(/hostRuntimeBase: runtimeBase/)
    // The updater cache is the one made just before (fix round 4), named by its variable
    expect(built).toMatch(/\n    updaterCache,\n/)
    expect(built).toMatch(/installRoot: installRootOf\(app\.getPath\('exe'\), process\.platform\)/)
    // Task E fix round 2: Astera's own %LOCALAPPDATA%\astera whole on Windows, and the public CLI's own files elsewhere
    expect(built).toMatch(/localAstera: localAsteraDir\(process\.platform, process\.env, os\.homedir\(\)\)/)
    expect(built).toMatch(/publicShuttle: publicShuttleFiles\(\{ platform: process\.platform, binDir: binDirFor\(\{ platform: process\.platform, env: process\.env, home: os\.homedir\(\) \}\), names: shuttleNames\(process\.platform\), exists: existsSync \}\)/)
    // Task E fix rounds 3 and 5: only what is there when the app starts, as spelled; where each really is is each
    // start's to decide (namedPathFor)
    expect(built).toMatch(/resolve: presentOrNull/)
  })
  it('makes the updater cache and the Host runtime folder before it builds the list, and names that same cache (fix round 4)', () => {
    const at = core.indexOf('const readOnly = sandboxReadOnly({')
    const before = core.slice(core.lastIndexOf('\n\n', at), at)
    expect(before).toMatch(/const updaterCache = updaterCacheDir\(process\.platform, process\.env, os\.homedir\(\)\)\n\s*ensureOwnFolders\(\[updaterCache, runtimeBase\]\)\n/)
    expect(core.slice(at, core.indexOf('\n  })', at))).toMatch(/\n    updaterCache,\n/)
  })
  // Fix round 5: and each looks at the links on the paths it names (nodeLinkLook)
  it('the StatusLineManager, the terminal checks and the chat deps all take that one list, and look at its links', () => {
    expect(core).toMatch(/const statusLine = new StatusLineManager\(\n    userDataDir,[\s\S]*\{ findRuntime, readOnly \}\n  \)/)
    // Fix round 6: Claude's twins take the way to look from the scope each start hands them (claudeSandboxStart)
    expect(core).toMatch(/const claudeSandbox = claudeSandboxStart\(\{[\s\S]*?\n    linkLook: nodeLinkLook,\n    log: sessionsLog\n  \}\)/)
    expect(core).toMatch(/\{ \.\.\.defaultSpawnChecks\(sessionsLog\), hostSocketDir, appKeyFile, readOnly, linkLook: nodeLinkLook, codexExcludes \}/)
    const chat = core.slice(core.indexOf('const chat = new ChatSessionManager({'), core.indexOf('// Lazy history'))
    expect(chat).toMatch(/\n    appKeyFile,\n    readOnly,\n    linkLook: nodeLinkLook,\n/)
  })
})

// Task E fix round 1 (review Minor 2): the Host hands its sandboxed chat sessions the same read-only list and app key it
// gives its terminal sessions. rollingWiring builds the chat deps from the spawner; hostChats passes them to the chat
// manager. Dropping either line would leave a Host-started sandboxed Codex chat without the entries, and nothing else
// would fail — so these are guarded by their text, as the wiring above is
describe('the Host hands its chat sessions the spawner’s read-only list and app key', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const rollingWiring = readFileSync(path.join(here, '..', 'host', 'rollingWiring.ts'), 'utf8')
  const hostChats = readFileSync(path.join(here, '..', 'host', 'hostChats.ts'), 'utf8')
  it('the spawner builds its list from what is there, as spelled (fix rounds 3 and 5)', () => {
    const spawner = readFileSync(path.join(here, '..', 'host', 'spawner.ts'), 'utf8')
    const built = spawner.slice(spawner.indexOf('const readOnly = sandboxReadOnly({'), spawner.indexOf('\n  })', spawner.indexOf('const readOnly = sandboxReadOnly({')))
    expect(built).toMatch(/resolve: presentOrNull/)
  })
  // Fix round 5: the Host's terminal checks and twins look at the links on the paths they name, and so do its chats
  it('the spawner, rollingWiring and hostChats hand the way to look at links to every start', () => {
    const spawner = readFileSync(path.join(here, '..', 'host', 'spawner.ts'), 'utf8')
    expect(spawner).toMatch(/\{ \.\.\.defaultSpawnChecks\(log\), codexWindowsReady, hostSocketDir, appKeyFile, readOnly, linkLook: nodeLinkLook, codexExcludes \}/)
    expect(spawner).toMatch(/const claudeSandbox = claudeSandboxStart\(\{[\s\S]*?\n    linkLook: nodeLinkLook,\n    log\n  \}\)/)
    expect(spawner).toMatch(/\n    sandboxWarn,\n    linkLook: nodeLinkLook,\n/)
    expect(rollingWiring).toMatch(/readOnly: a\.spawner\.readOnly \?\? \[\],\n    linkLook: a\.spawner\.linkLook,\n/)
    expect(hostChats).toMatch(/\n    linkLook: d\.linkLook,\n/)
  })
  it('the spawner makes the updater cache and its runtime folder before it builds the list (fix round 4)', () => {
    const spawner = readFileSync(path.join(here, '..', 'host', 'spawner.ts'), 'utf8')
    const at = spawner.indexOf('const readOnly = sandboxReadOnly({')
    expect(spawner.slice(spawner.lastIndexOf('\n\n', at), at)).toMatch(/const updaterCache = updaterCacheDir\(platform, d\.env, homeDir\)\n\s*ensureOwnFolders\(\[updaterCache, hostRuntimeDir\]\)\n/)
    expect(spawner.slice(at, spawner.indexOf('\n  })', at))).toMatch(/\n    updaterCache,\n/)
  })
  it('rollingWiring reads them off the spawner for the chat deps', () => {
    expect(rollingWiring).toMatch(/appKeyFile: a\.spawner\.appKeyFile \?\? null,\n    readOnly: a\.spawner\.readOnly \?\? \[\],/)
  })
  it('hostChats passes both on to the chat manager', () => {
    expect(hostChats).toMatch(/\.\.\.\(d\.appKeyFile !== undefined \? \{ appKeyFile: d\.appKeyFile \} : \{\}\),\n    \.\.\.\(d\.readOnly !== undefined \? \{ readOnly: d\.readOnly \} : \{\}\),/)
  })
})

// Task E fix rounds 2 and 3: every start path tells a sandboxed start's warnings (the managers decide, startWarningsFor,
// and put them on the session's info and note, which the tab shows as a line above the terminal or the chat). The
// app's two managers are given the sink in ipc.ts; the Host's terminal manager in spawner.ts; the Host's chats through
// rollingWiring and hostChats (the chat notice to the apps). Every sink logs to the Host log; nothing is written into a
// terminal's pty stream any more (round 3: Codex and Claude Code's fullscreen draw on the alternate screen, which hides a
// line written at the start until the CLI exits). Each asks the once-per-process Ubuntu check. registerIpc and the
// Host's compose cannot run here: guarded by their text
describe('every start path carries the sandbox start warnings', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const read = (rel: string): string => readFileSync(path.join(here, rel), 'utf8')
  /** The object a `<lhs> = {` or `const <lhs>: … = {` assignment gives, up to its closing brace at the same indent. */
  const sinkOf = (text: string, opening: string): string => {
    const at = text.indexOf(opening)
    expect(at, opening).toBeGreaterThan(-1)
    const indent = /[ ]*$/.exec(text.slice(0, at))![0]
    return text.slice(at, text.indexOf(`\n${indent}}`, at))
  }
  it('the app gives both managers the sink: the Host log for a terminal, and a chat its notice too', () => {
    const ipc = read('ipc.ts')
    const terminal = sinkOf(ipc, 'core.sessions.sandboxWarn = {')
    expect(terminal).toMatch(/claudeUsernsRestricted,\n\s*warn: \(id, ws\) => hostWiring\?\.log\(`sandbox: session=\$\{id\} starts with a warning: \$\{ws\.join\(', '\)\}`\)/)
    expect(terminal).not.toMatch(/\.say\(|\[Astera\]/)
    expect(ipc).toMatch(/core\.chat\.sandboxWarn = \{[\s\S]*?claudeUsernsRestricted,[\s\S]*?core\.chat\.notice\(id, \{ key: 'rollRefused', reason: m \}\)/)
    expect(ipc).toMatch(/const claudeUsernsRestricted = claudeUsernsCheck\(process\.platform\)/)
  })
  it('the Host gives its terminal manager the sink: the Host log, and nothing into the pty ring', () => {
    const spawner = read('../host/spawner.ts')
    expect(spawner).toMatch(/const claudeUsernsRestricted = claudeUsernsCheck\(platform\)/)
    const sink = sinkOf(spawner, 'const sandboxWarn: SandboxWarnSink = {')
    expect(sink).toMatch(/claudeUsernsRestricted,\n\s*warn: \(id, ws\) => log\(`sandbox: session=\$\{id\} starts with a warning: \$\{ws\.join\(', '\)\}`\)/)
    expect(sink).not.toMatch(/registry\.say|\[Astera\]/)
    expect(spawner).toMatch(/sessions\.sandboxWarn = sandboxWarn\n/)
    // Exposed, so the Host's chats ask the same once-per-process check (rollingWiring)
    expect(spawner).toMatch(/\n    readOnly,\n    sandboxWarn,\n/)
    // No language to word a line in: the Host's index no longer hands the spawner one
    const index = read('../host/index.ts')
    const call = index.slice(index.indexOf('const spawner = createHostSpawner({'), index.indexOf('\n  })', index.indexOf('const spawner = createHostSpawner({')))
    expect(call).toMatch(/profileDir,/)
    expect(call).not.toMatch(/\blang:/)
  })
  it('the Host hands its chats the sink through rollingWiring and hostChats: the chat notice to the apps, and the log', () => {
    const rollingWiring = read('../host/rollingWiring.ts')
    const hostChats = read('../host/hostChats.ts')
    expect(rollingWiring).toMatch(/sandboxWarn: \{[\s\S]*?claudeUsernsRestricted: a\.spawner\.sandboxWarn\?\.claudeUsernsRestricted \?\? \(\(\) => false\),[\s\S]*?\{ t: 'chat-notice', sessionId: id, notice: \{ key: 'rollRefused', reason: m \} \}/)
    expect(hostChats).toMatch(/\.\.\.\(d\.sandboxWarn \? \{ sandboxWarn: d\.sandboxWarn \} : \{\}\),/)
  })
})

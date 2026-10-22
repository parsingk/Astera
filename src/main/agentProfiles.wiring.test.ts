// Agent Profiles design §5: the app's spawn paths resolve the profile a spawn names (a name to its id, one that does not
// resolve dropped) with profileSpawn (appProfileSpawn for a person's spawn), whose rules core/agentProfiles/permission.test.ts pins, then hand the id to the
// capability refresh and the spawn, and stamp the profile's use after it. registerIpc cannot run without Electron, so the
// wiring is guarded by its text, as agentSessions.wiring.test.ts guards who started a session.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

  it('a terminal session: the prepare takes the profile, the spawn carries it in opts, and its use is stamped after', () => {
    expect(terminal).toMatch(/core\.sessions\.prepare\(\{ account, cwd: opts\.cwd, \.\.\.\(opts\.agentProfileId !== undefined \? \{ agentProfileId: opts\.agentProfileId \} : \{\}\) \}\)/)
    expect(before(terminal, 'core.sessions.spawn({', 'touchAgentProfile(opts.agentProfileId)')).toBe(true)
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
// own tests pin that), and index.ts's two coordinators must pass it on to the prepare that warms the capabilities.
describe('index.ts prepares a roll on the chain’s agent profile', () => {
  const index = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8')

  it('both coordinators’ prepareSpawn pass the profile id to the prepare', () => {
    const lines = index.split('\n').filter((l) => l.includes('prepareSpawn:'))
    expect(lines).toHaveLength(2)
    for (const l of lines) {
      expect(l).toMatch(/prepareSpawn: \(account, cwd, agentProfileId\) => core!\.sessions\.prepare\(\{ account, cwd, \.\.\.\(agentProfileId \? \{ agentProfileId \} : \{\}\) \}\)/)
    }
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

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatAdoptPlan } from './chatAdopt'

const plan = (over: Partial<Parameters<typeof chatAdoptPlan>[0]> = {}) =>
  chatAdoptPlan({ restore: {}, hostSpeaksChatTakeover: true, rollAccounts: 2, adopting: false, appHoldsOld: () => false, rolledFrom: null, ...over })

describe('chatAdoptPlan (chat takeover, the app side)', () => {
  it('defers a proc the Host is still starting, only in front of a chat-takeover Host (P5)', () => {
    expect(plan({ restore: { hostStarting: true } }).defer).toBe(true)
    expect(plan({ restore: { hostStarting: true }, hostSpeaksChatTakeover: false }).defer).toBe(false)
    expect(plan({ restore: { hostStarting: null } }).defer).toBe(false)
  })
  it('leaves a Host-marked chain to the Host, and decides otherwise', () => {
    expect(plan({ restore: { rolledBy: 'host' } }).rolling).toBe('host')
    expect(plan({ restore: { rolledBy: 'host' }, hostSpeaksChatTakeover: false }).rolling).toBe('decide')
    expect(plan({ restore: {} }).rolling).toBe('decide')
  })
  // Review Focus 1.
  it('a Host-rolled chat proc adopted as the new half of a pushed roll announces no second tab', () => {
    expect(plan({ adopting: true, rolledFrom: 'c1', appHoldsOld: (id) => id === 'c1' }).announce).toBe(false)
    expect(plan({ adopting: true, rolledFrom: 'c1', appHoldsOld: () => false }).announce).toBe(true)
    expect(plan({}).announce).toBe(true)
  })
  // Fix round 1, M1: the sweep's proc list landed before the session-rolled push (or no push is coming:
  // the app was disconnected through the roll). The note says which session this proc replaced.
  it('re-points the old tab for a Host-rolled proc whose note names a session the app holds, instead of a second tab', () => {
    const restore = { rolledBy: 'host', rolledFrom: 'c1' }
    const p = plan({ restore, appHoldsOld: (id) => id === 'c1' })
    expect(p.repoint).toBe('c1')
    expect(p.announce).toBe(false)
    // Not when the app never held the old one, not for a proc it held already (a reconnect re-adoption),
    // not for a note the Host did not mark, and not while the push itself is adopting it.
    expect(plan({ restore, appHoldsOld: () => false })).toMatchObject({ repoint: null, announce: true })
    expect(plan({ restore, appHoldsOld: () => true, appHeldNew: true })).toMatchObject({ repoint: null, announce: true })
    expect(plan({ restore: { rolledFrom: 'c1' }, appHoldsOld: () => true })).toMatchObject({ repoint: null, announce: true })
    expect(plan({ restore, adopting: true, rolledFrom: 'c1', appHoldsOld: () => true })).toMatchObject({ repoint: null, announce: false })
  })
})


// registerIpc cannot run without Electron, so its chat takeover wiring is guarded by its text (the style
// of offlineRolls.test.ts). Fix round 1, I1: each of these lines, deleted, turns one of them red.
describe('ipc.ts wires the chat adopter (chat takeover Task 9)', () => {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ipc.ts'), 'utf8')
  const start = src.indexOf('chat: (a) => {')
  const end = src.indexOf('log: (m) => hostLog(`host: ${m}`),', start)
  const adopter = src.slice(start, end)
  it('finds the adopter', () => {
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
  })
  it('leaves a Host-marked chain to the Host (R8), and decides the rest over the chat-takeover feature', () => {
    expect(adopter).toMatch(/if \(plan\.rolling === 'host'\) unregister\(\)/)
    expect(adopter).toMatch(/hostRolls: hostSpeaksChatTakeover\(client\.status\(\)\)/)
    expect(adopter).toMatch(/if \(plan\.rolling === 'host'\) hostOwned\.add\(info\.id\)/)
  })
  it('announces only when the plan says so, once, and re-points otherwise (Review Focus 1, M1)', () => {
    expect(adopter).toMatch(/if \(plan\.announce\) \{\s*try \{\s*send\('session:created', info\)/)
    expect(adopter.split("send('session:created'").length - 1).toBe(1)
    expect(adopter).toMatch(/else if \(plan\.repoint !== null\) hostRollView\.repointed\(plan\.repoint, info\)/)
    expect(adopter).toMatch(/const appHeldNew = core\.chat\.has\(a\.id\)\s*const info = core\.chat\.adopt\(a\)/)
  })
  it('defers a proc the Host is still starting (P5)', () => {
    expect(src.slice(end, end + 800)).toMatch(
      /deferProc: \(e\) => e\.meta\?\.kind === 'chat' && hostStartingDefers\(e\.meta\.restore, hostSpeaksChatTakeover\(client\.status\(\)\)\)/
    )
  })
  it("takes back a chat roll's new proc through the sweep queue", () => {
    expect(src).toMatch(/else if \(procId && takeBackRolledProc\) await takeBackRolledProc\(procId\)/)
    expect(src).toMatch(/takeBackRolledProc = \(procId\) => takeSessionsBack\('the Host rolled a chat session', undefined, procId\)/)
    expect(src.slice(end, end + 800)).toMatch(/only,\s*onlyProc\s*\}\)/)
  })
  it("guards a history resume with the Host's chat proc notes (carry 2)", () => {
    expect(src).toMatch(/listProcs: hostSpeaksChatTakeover\(hostClient\?\.status\(\) \?\? \{ connected: false, features: \[\] \}\) \? hostProcList : null/)
    expect(src).toMatch(/core\.chat\.list\(\)\.find\(\(x\) => x\.id === id && x\.status === 'running'\)/)
  })
})

// spawnSession is the same unreachable registerIpc closure (see above), and its chat branch carries a
// freshly spawned session's unattended-permission pick from the raw IPC opts into core.chat.spawn.
// Guarded by text for the same reason: dropping this ternary (or hardcoding 'hold') would make every
// chat session spawned through the New Session dialog ignore the person's pick — silently, since 'hold'
// is a valid policy on its own and nothing would throw (fix round, chat takeover Task 10).
describe("ipc.ts carries the unattended-permission pick into core.chat.spawn (chat takeover Task 10 fix)", () => {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ipc.ts'), 'utf8')
  it('forwards a valid pick from opts, defaulting a missing or invalid one to hold', () => {
    expect(src).toMatch(
      /unattendedPermission: isUnattendedPermission\(opts\.unattendedPermission\) \? opts\.unattendedPermission : 'hold'/
    )
  })
})

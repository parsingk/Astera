import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatAdoptPlan, hostCarryOnIsOurs } from './chatAdopt'

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
  // CT-16: a codex chat roll's `dest` (the rollout copy its resume appends to) is noted by the Host as
  // `rollDest`, and a re-point hands it on the way the push would.
  it('a re-point carries the codex dest the note keeps, and only a re-point does (CT-16)', () => {
    const restore = { rolledBy: 'host', rolledFrom: 'c1', rollDest: 'C:/acc2/sessions/rollout-x.jsonl' }
    expect(plan({ restore, appHoldsOld: (id) => id === 'c1' })).toMatchObject({ repoint: 'c1', dest: 'C:/acc2/sessions/rollout-x.jsonl' })
    expect(plan({ restore: { rolledBy: 'host', rolledFrom: 'c1' }, appHoldsOld: () => true }).dest).toBeNull()
    expect(plan({ restore: { ...restore, rollDest: 7 }, appHoldsOld: () => true }).dest).toBeNull()
    expect(plan({ restore, appHoldsOld: () => false }).dest).toBeNull()
  })
})

describe('hostCarryOnIsOurs (final review I1)', () => {
  const carry = { rolledBy: 'host', carryOn: 'carry on', carrySent: false }
  it('is true for a Host-rolled proc whose carry-on nobody sent, in front of a chat-takeover Host', () => {
    expect(hostCarryOnIsOurs(carry, true)).toBe(true)
  })
  it.each([
    ['an older Host', carry, false],
    ['a proc this app rolled', { ...carry, rolledBy: undefined }, true],
    ['a carry-on already sent', { ...carry, carrySent: true }, true],
    ['no carry-on', { rolledBy: 'host' }, true]
  ])('is false for %s', (_why, restore, speaks) => {
    expect(hostCarryOnIsOurs(restore as Record<string, unknown>, speaks as boolean)).toBe(false)
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
    expect(adopter).toMatch(/else if \(plan\.repoint !== null\) hostRollView\.repointed\(plan\.repoint, info, plan\.dest\)/)
    expect(adopter).toMatch(/const appHeldNew = core\.chat\.has\(a\.id\)\s*const info = core\.chat\.adopt\(a\)/)
  })
  it('defers a proc the Host is still starting (P5)', () => {
    expect(src.slice(end, end + 800)).toMatch(
      /deferProc: \(e\) => e\.meta\?\.kind === 'chat' && hostStartingDefers\(e\.meta\.restore, hostSpeaksChatTakeover\(client\.status\(\)\)\)/
    )
  })
  // Final review I1. Mutation: drop the afterAttachProc line, or its sendCarryOn call.
  it('sends the carry-on the Host left once the proc-attach is out', () => {
    expect(src.slice(end, end + 1600)).toMatch(
      /afterAttachProc: \(e\) => \{\s*if \(e\.meta\?\.kind === 'chat' && hostCarryOnIsOurs\(e\.meta\.restore, hostSpeaksChatTakeover\(client\.status\(\)\)\)\)\s*core\.chat\.sendCarryOn\(e\.meta\.id\)/
    )
  })
  it("takes back a chat roll's new proc through the sweep queue", () => {
    expect(src).toMatch(/else if \(procId && takeBackRolledProc\) await takeBackRolledProc\(procId\)/)
    expect(src).toMatch(/takeBackRolledProc = \(procId\) => takeSessionsBack\('the Host rolled a chat session', undefined, procId\)/)
    expect(src.slice(end, end + 1600)).toMatch(/only,\s*onlyProc\s*\}\)/)
  })
  // Slack in the Host Task 4 (spec S5). Mutation: drop the thread from either adopter's register, or the
  // notifier's remember dep, and an app restart opens a second root for every Slack session.
  it('registers both adopted kinds with the thread their note names, and the notifier can note one', () => {
    const adoptersStart = src.indexOf('adopters: {')
    const adopterSlice = src.slice(adoptersStart, end)
    expect(adoptersStart).toBeGreaterThan(-1)
    expect(adoptersStart).toBeLessThan(start)
    const registers = adopterSlice.match(/notifier\.register\(info, \{ thread: notedThreadOf\(a\.restore\) \}\)/g) ?? []
    expect(registers).toHaveLength(2)
    expect(adopterSlice.slice(start - adoptersStart)).toMatch(/notifier\.register\(info, \{ thread: notedThreadOf\(a\.restore\) \}\)/)
    const index = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8')
    const depsStart = index.indexOf('new SlackNotifier({')
    const deps = index.slice(depsStart, index.indexOf('const attention = createAttentionState()', depsStart))
    expect(depsStart).toBeGreaterThan(-1)
    expect(deps).toMatch(/remember: \(sid, patch\) =>/)
  })
  it("guards a history resume with the Host's chat proc notes (carry 2)", () => {
    expect(src).toMatch(/listProcs: hostSpeaksChatTakeover\(hostClient\?\.status\(\) \?\? \{ connected: false, features: \[\] \}\) \? hostProcList : null/)
    expect(src).toMatch(/core\.chat\.list\(\)\.find\(\(x\) => x\.id === id && x\.status === 'running'\)/)
  })
})

// Final review M3: the app's chatAnswer reads a failure as the Host does. Mutation: put back the bare
// catch that answered not-open for every failure.
describe('ipc.ts maps a failed chat answer by its cause (final review M3)', () => {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ipc.ts'), 'utf8')
  it('answers not-open only through chatAnswerFailureOf', () => {
    const start = src.indexOf('chatAnswer: async (sid, rid, decision) => {')
    const body = src.slice(start, src.indexOf('chatSend: async (sessionId, text) => {', start))
    expect(start).toBeGreaterThan(-1)
    expect(body).toMatch(/\} catch \(err\) \{[\s\S]*const failed = chatAnswerFailureOf\(err\)[\s\S]*return failed/)
    expect(body.split("reason: 'not-open'").length - 1).toBe(1)
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

// Slack in the Host Task 7 (P10). Mutation: drop the branch, and every Slack card answer on a chat this
// app writes fails as `unknown act`.
describe('ipc.ts answers a Slack card for a chat this app writes (Slack in the Host Task 7)', () => {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ipc.ts'), 'utf8')
  it('answers slackChatAnswer through answerSlackCard, before the orch table', () => {
    const start = src.indexOf("if (m.t !== 'orch-act') return")
    const table = src.indexOf('answerOrchAct(', start)
    const branch = src.indexOf('if (m.act === HOST_ACT_SLACK_ANSWER)', start)
    expect(start).toBeGreaterThan(-1)
    expect(branch).toBeGreaterThan(start)
    expect(branch).toBeLessThan(table)
    expect(src.slice(branch, table)).toMatch(/answerSlackCard\(core\.chat, m\.args\)/)
  })
})

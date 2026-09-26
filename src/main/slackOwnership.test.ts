import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { createSlackOwnership, SLACK_HANDBACK_MS } from './slackOwnership'
import { HOST_FEATURE_SLACK_OWNER } from '../core/host/protocol'
import type { SlackConfig } from '../core/slack/config'

const CFG: SlackConfig = { webhookUrl: null, botToken: 'xoxb-fake', channelId: 'C1', appToken: 'xapp-fake', memberId: 'U1' }
const owner = { connected: true, features: [HOST_FEATURE_SLACK_OWNER] }
const older = { connected: true, features: ['rolling'] }
const closed = { connected: false, features: [] }
const flush = () => new Promise((r) => setTimeout(r, 0))

function rig() {
  const trail: string[] = []
  const heard: unknown[] = []
  let fire: (() => void) | null = null
  let armedFor = 0
  const o = createSlackOwnership({
    load: async () => ({ ...CFG }),
    apply: () => trail.push('apply'),
    yieldAll: () => trail.push('yield'),
    hear: (ev) => heard.push(ev),
    after: (ms, fn) => { armedFor = ms; fire = fn; return () => { fire = null } },
    log: () => {}
  })
  const sent: unknown[] = []
  o.setHost({ reload: async () => { trail.push('reload') }, forward: (ev) => sent.push(ev) })
  return { o, trail, sent, heard, fire: () => fire?.(), armed: () => fire !== null, armedFor: () => armedFor }
}

describe('createSlackOwnership (Slack in the Host Task 8, S1, S2, P5)', () => {
  // Review Focus 1.
  it('builds nothing before the startup chain settles, and yields at once to a Slack-owning Host', async () => {
    const h = rig()
    await flush()
    expect(h.trail).toEqual([])
    expect(h.o.owner()).toBe('undecided')
    h.o.status(owner)
    expect(h.o.owner()).toBe('host')
    h.o.settled()
    await flush()
    expect(h.trail).toEqual(['yield'])
    expect(h.o.local()).toBe(false)
  })

  it('takes Slack when the chain settles with no Host or an older one', async () => {
    for (const s of [closed, older]) {
      const h = rig()
      h.o.status(s)
      h.o.settled()
      await flush()
      expect(h.trail).toEqual(['apply'])
      expect(h.o.owner()).toBe('app')
    }
  })

  // Review Focus 1.
  it('takes Slack back only after the hand-back grace, and not when the Host returns inside it', async () => {
    const h = rig()
    h.o.status(owner)
    h.o.settled()
    h.o.status(closed)
    expect(h.o.owner()).toBe('host')
    expect(h.armedFor()).toBe(SLACK_HANDBACK_MS)
    h.o.status(owner)
    expect(h.armed()).toBe(false)
    h.o.status(closed)
    h.fire()
    await flush()
    expect(h.o.owner()).toBe('app')
    expect(h.trail).toEqual(['yield', 'apply'])
  })

  it('an unresponsive Slack-owning Host still owns Slack', () => {
    const h = rig()
    h.o.status(owner)
    h.o.status({ connected: false, unresponsive: true, features: [HOST_FEATURE_SLACK_OWNER] })
    expect(h.armed()).toBe(false)
    expect(h.o.owner()).toBe('host')
  })

  it('a settings save is applied here when the app owns, and sent as slack-reload when the Host does', async () => {
    const mine = rig()
    mine.o.status(older)
    mine.o.settled()
    await flush()
    await mine.o.configChanged(CFG)
    expect(mine.trail).toEqual(['apply', 'apply'])
    const host = rig()
    host.o.status(owner)
    await host.o.configChanged(CFG)
    expect(host.trail).toEqual(['yield', 'reload'])
  })

  it('forwards only while the Host owns Slack', () => {
    const h = rig()
    const ev = { kind: 'roll-state' as const, event: { sessionId: 's1', state: 'nudged' as const } }
    expect(h.o.forward(ev)).toBe(false)
    h.o.status(owner)
    expect(h.o.forward(ev)).toBe(true)
    expect(h.sent).toEqual([ev])
  })

  // Task 8 carry 2: the forward reaches the Host client before it returns, so the app's roll tap sends the
  // `rolled` in the same turn as the respawn's pty-spawn, behind it on the one socket.
  it('hands a forward to the Host client synchronously, and a throwing client costs the caller nothing', () => {
    const h = rig()
    h.o.status(owner)
    const ev = { kind: 'rolled' as const, oldSessionId: 's1', info: { id: 's2', accountId: 'a1', cwd: 'D:/p', title: 't' } as never }
    h.o.forward(ev)
    expect(h.sent).toEqual([ev])
    h.o.setHost({ reload: async () => {}, forward: () => { throw new Error('socket gone') } })
    expect(h.o.forward(ev)).toBe(false)
  })

  // Final review M2: a forward during the hand-back grace went to a closed client and was lost; a lost
  // `request` left a Slack reply to that card read as a turn.
  it('a forward while the Host is away is held, and reaches the Host when it answers again', () => {
    const h = rig()
    h.o.status(owner)
    h.o.status(closed)
    const ev = { kind: 'roll-state' as const, event: { sessionId: 's1', state: 'nudged' as const } }
    expect(h.o.forward(ev)).toBe(true)
    expect(h.sent).toEqual([])
    h.o.status(owner)
    expect(h.sent).toEqual([ev])
    expect(h.heard).toEqual([])
  })

  it("held forwards go to the app's own notifier once the grace ends and the app takes Slack", async () => {
    const h = rig()
    h.o.status(owner)
    h.o.settled()
    h.o.status(closed)
    const ev = { kind: 'roll-state' as const, event: { sessionId: 's1', state: 'nudged' as const } }
    h.o.forward(ev)
    h.fire()
    await flush()
    expect(h.trail).toEqual(['yield', 'apply'])
    expect(h.heard).toEqual([ev])
    expect(h.sent).toEqual([])
  })

  // Final review M3: a save while ownership was undecided was dropped, and a Host that had already
  // activated kept the config it read before the save.
  it('a settings save before ownership is decided, or while the Host is away, is sent as slack-reload once it speaks slack-owner', async () => {
    const early = rig()
    await early.o.configChanged(CFG)
    expect(early.trail).toEqual([])
    early.o.status(owner)
    await flush()
    expect(early.trail).toEqual(['yield', 'reload'])
    const away = rig()
    away.o.status(owner)
    away.o.status(closed)
    await away.o.configChanged(CFG)
    expect(away.trail).toEqual(['yield'])
    away.o.status(owner)
    await flush()
    expect(away.trail).toEqual(['yield', 'reload'])
    // Sent once: a later status says nothing new.
    away.o.status(owner)
    await flush()
    expect(away.trail).toEqual(['yield', 'reload'])
  })
})

// Task 8 carry 3 (the single-socket invariant, the app half). The Host opens its socket the moment a hello
// that yields `slack` reaches it (Task 5: onAppsChanged rides the hello), before the app hears the reply.
// So an app that holds its socket must not yield in that hello, or two sockets share the token until its
// teardown lands.
describe('the app half of the Slack handover never overlaps the Host socket (Task 8 carry 3)', () => {
  /** A Host on the other end: it holds its socket from the hello on when it owns Slack and the hello
   *  yielded; the app's socket is open from `apply` until `yield`. `check` fails on any overlap. */
  function world() {
    const h = rig()
    let appOpen = false
    let hostOpen = false
    const overlaps: string[] = []
    const check = (at: string) => { if (appOpen && hostOpen) overlaps.push(at) }
    const base = h.trail.push.bind(h.trail)
    h.trail.push = (...xs: string[]) => {
      for (const x of xs) {
        if (x === 'apply') appOpen = true
        if (x === 'yield') appOpen = false
        check(x)
      }
      return base(...xs)
    }
    return {
      h,
      overlaps,
      /** A (re)connect: the hello goes out, then the reply's status arrives. */
      connect: (kind: 'owner' | 'older') => {
        const kept = h.o.helloKeeps()
        hostOpen = kind === 'owner' && !kept
        check(`hello ${kind}`)
        h.o.status(kind === 'owner' ? owner : older)
        check(`status ${kind}`)
      },
      drop: () => { hostOpen = false; h.o.status(closed) },
      hostOpen: () => hostOpen,
      appOpen: () => appOpen
    }
  }

  it('an app holding its socket says hello without the slack yield, keeps Slack, and the Host stays shut', async () => {
    const w = world()
    w.h.o.status(closed)
    w.h.o.settled()
    await flush()
    expect(w.appOpen()).toBe(true)
    // Mutation: yield slack in every hello (the brief's static list), and the Host opens beside the app.
    expect(w.h.o.helloKeeps()).toBe(true)
    w.connect('owner')
    await flush()
    expect(w.overlaps).toEqual([])
    expect(w.h.o.owner()).toBe('app')
    expect(w.h.o.local()).toBe(true)
    expect(w.h.o.forward({ kind: 'roll-state', event: { sessionId: 's1', state: 'nudged' } })).toBe(false)
    expect([...w.h.trail]).toEqual(['apply'])
  })

  it('an app holding no socket yields in its hello and hands Slack to the Host', async () => {
    const w = world()
    expect(w.h.o.helloKeeps()).toBe(false)
    w.connect('owner')
    w.h.o.settled()
    await flush()
    expect(w.h.o.owner()).toBe('host')
    expect(w.hostOpen()).toBe(true)
    expect(w.appOpen()).toBe(false)
  })

  it('a reconnect inside the grace restarts it, so the grace never fires under a hello the Host has taken', () => {
    let armed = 0
    let cancelled = 0
    const o = createSlackOwnership({
      load: async () => ({ ...CFG }),
      apply: () => {},
      yieldAll: () => {},
      after: () => { armed++; return () => { cancelled++ } },
      log: () => {}
    })
    o.status(owner)
    o.status(closed)
    expect([armed, cancelled]).toEqual([1, 0])
    // The client's reconnect: a hello that yields goes out while the grace is armed.
    expect(o.helloKeeps()).toBe(false)
    expect([armed, cancelled]).toEqual([2, 1])
    // A hello with no grace armed arms nothing.
    o.status(owner)
    expect(o.helloKeeps()).toBe(false)
    expect(armed).toBe(2)
  })

  it('if the grace fires anyway before the reply, the reply that says slack-owner makes the app yield at once', async () => {
    const w = world()
    w.connect('owner')
    w.h.o.settled()
    w.drop()
    // A yielding hello is out, then the grace fires before the answer: the app takes Slack.
    expect(w.h.o.helloKeeps()).toBe(false)
    w.h.fire()
    await flush()
    expect(w.h.o.owner()).toBe('app')
    // The answer: this Host took the yield, so the app gives its socket up.
    w.h.o.status(owner)
    expect(w.h.o.owner()).toBe('host')
    expect(w.h.trail.slice(-1)).toEqual(['yield'])
  })

  it('never has both sockets open over a run of drops, reconnects, graces and older Hosts', async () => {
    const w = world()
    w.connect('owner')
    w.h.o.settled()
    await flush()
    const steps: Array<() => void | Promise<void>> = [
      () => w.drop(),
      () => w.connect('owner'),
      () => w.drop(),
      () => w.h.fire(),
      flush,
      () => w.connect('owner'),
      flush,
      () => w.drop(),
      () => w.connect('older'),
      () => w.h.fire(),
      flush,
      () => w.drop(),
      () => w.connect('owner'),
      flush
    ]
    for (const s of steps) await s()
    expect(w.overlaps).toEqual([])
    expect(w.h.o.owner()).toBe('app')
    expect(w.hostOpen()).toBe(false)
  })
})

describe('the app Slack wiring (Slack in the Host Task 8, text guards: ipc.ts and index.ts are not rigged)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const ipc = readFileSync(path.join(here, 'ipc.ts'), 'utf8')
  const index = readFileSync(path.join(here, 'index.ts'), 'utf8')

  it('index.ts opens no socket at start, and gates every notifier input on the ownership', () => {
    // Mutation: bring back the load-then-apply at start, and two sockets share the token until the handshake.
    expect(index).not.toMatch(/slackStore\.load\(\)\.then\(/)
    expect(index).toMatch(/createSlackOwnership\(/)
    // Mutation: drop a gate, and the app posts beside the Host (or, for the hook fan-out, reads transcripts for nothing).
    expect(index).toMatch(/onTurnComplete: \(sessionId, rolloutPath\) => \{\s*if \(slackOwnership\.local\(\)\) slack\.onCodexTurnComplete/)
    expect(index).toMatch(/onHookEvent: \(sid, p\) => \{\s*if \(slackOwnership\.local\(\)\) slack\.onHookEvent\(sid, p\)/)
    const tap = index.slice(index.indexOf('Slack notifications tap rolling events too'))
    expect(tap).toMatch(/if \(slackOwnership\.local\(\)\)/)
    // Mutation: forward a Host roll back to the Host (orchestration false), and it is announced twice.
    expect(tap).toMatch(/else if \(opts\.orchestration\)/)
    // Final review M2: forwards held while the Host was away reach this app's notifier when it takes Slack.
    // Mutation: drop `hear`, and what the grace held is lost when the app takes over.
    const own = index.slice(index.indexOf('createSlackOwnership({'))
    expect(own.slice(0, own.indexOf('slackOwnershipRef = slackOwnership'))).toMatch(/hear: \(ev\) => hearForwarded\(slack, ev\)/)
  })

  it('ipc.ts decides after the startup chain, follows the status, forwards chat events and reloads the Host', () => {
    expect(ipc).toMatch(/hostSessionsTakenBack\.then\(\(\) => slack\?\.ownership\.settled\(\)\)/)
    expect(ipc).toMatch(/slack\?\.ownership\.status\(s\)/)
    expect(ipc).toMatch(/slack\?\.ownership\.setHost\(\{/)
    expect(ipc).toMatch(/await slack\.ownership\.configChanged\(normalized\)/)
    expect(ipc).toMatch(/if \(slack\?\.ownership\.local\(\) !== false\) slack\?\.notifier\.handleData\(e\)/)
    expect(ipc).toMatch(/if \(slack\?\.ownership\.local\(\) !== false\) slack\?\.notifier\.handleExit\(e\)/)
    expect(ipc).toMatch(/isForwardedChatEvent\(event\)/)
    expect(ipc).toMatch(/hostPostsSlack: \(\) => slack\?\.ownership\.owner\(\) === 'host'/)
  })

  // Carry 3. Mutation: drop the option, and the client's hello yields slack while this app holds its socket.
  it('ipc.ts asks the ownership at every hello whether to leave the slack yield out', () => {
    expect(ipc).toMatch(/keepsSlack: \(\) => slack\?\.ownership\.helloKeeps\(\) \?\? false/)
  })

  // Task 4 carry. Mutation: register the bypass retry with no thread, and the retried session opens a
  // second root beside the one its note names.
  it('ipc.ts registers a bypass retry with the thread its note names', () => {
    const retry = ipc.slice(ipc.indexOf("ipcMain.handle('chat.retryWithBypass'"))
    expect(retry.slice(0, retry.indexOf('send(\'session:created\', info)'))).toMatch(
      /slack\?\.notifier\.register\(info, \{ thread: notedThreadOf\(core\.chat\.spawnNote\(info\.id\) \?\? \{\}\) \}\)/
    )
  })
})

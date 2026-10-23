// Plugin Phase 3 (events and notifications design N2, N3): the Host's composition, read from its source as
// driving.integration.test.ts reads it. The recorder exists only with the rolling (no spawner, no session events),
// hears every hook event and the rolling's roll states, takes `session-signal` only from a greeted app, records into
// the public event log, and stops with the Host.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8')

describe('the Host wires its session events', () => {
  it('makes the recorder only with the rolling, over the event log and the session rows', () => {
    const at = src.indexOf('sessionEvents = rollingWiring')
    expect(at).toBeGreaterThan(0)
    const call = src.slice(at, at + 800)
    expect(call).toMatch(/\? createHostSessionEvents\(\{/)
    expect(call).toMatch(/record: \(drafts\) => eventLog\.recorded\(drafts\)/)
    expect(call).toMatch(/sessionById: async \(id\) => \(await hostSessions\.sessionById\?\.\(id\)\) \?\? null/)
    expect(call).toMatch(/chats: rollingWiring\.chats/)
    expect(call).toMatch(/rolling: rollingWiring\.rolling/)
    expect(call).toMatch(/: null/)
    expect(at).toBeGreaterThan(src.indexOf('const hostSessions = registrySessions('))
  })

  it('hears every hook event and the rolling’s roll states beside the Slack', () => {
    const rolling = src.slice(src.indexOf('composeHostRolling('))
    expect(rolling).toMatch(/hookTap: \(sid, p\) => \{\s*slackWiring\?\.onHookEvent\(sid, p\)\s*sessionEvents\?\.onHookEvent\(sid, p\)\s*\}/)
    expect(rolling).toMatch(/slackWiring\?\.onRollEvent\(e\)\s*if \(e\.t === 'roll-state'\) sessionEvents\?\.onRollState\(e\.event\)/)
  })

  it('takes session-signal from a greeted app only, before the pty handler', () => {
    const intake = src.indexOf("m.t === 'session-signal'")
    expect(intake).toBeGreaterThan(0)
    expect(src.slice(intake, intake + 300)).toMatch(/sessionEvents && from\.greeted && from\.role === 'app'/)
    expect(src.slice(intake, intake + 300)).toMatch(/sessionEvents\.forwarded\(m\.signal\)/)
    expect(intake).toBeLessThan(src.indexOf('handlePty?.(m, send, { socket: from.socket })'))
  })

  it('stops it with the Host, beside the rolling that feeds it', () => {
    const leave = src.slice(src.indexOf('const leave = (why?: string): void => {'))
    expect(leave.slice(0, 4000)).toMatch(/rollingWiring\?\.dispose\(\)[^]*?sessionEvents\?\.dispose\(\)/)
  })
})

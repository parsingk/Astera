import { describe, it, expect } from 'vitest'
import { PtyRegistry, type RegistryPty } from './registry'
import { ProcRegistry, type RegistryProc } from './procRegistry'
import { createHostSlackSessions } from './slackSessions'
import type { SessionInfo } from '../core/types'

function pty(): RegistryPty & { exit(code: number): void; emit(d: string): void } {
  let onData: (d: string) => void = () => {}
  let onExit: (e: { exitCode: number }) => void = () => {}
  return { pid: 1, onData: (cb) => { onData = cb }, onExit: (cb) => { onExit = cb }, write: () => {}, resize: () => {}, kill: () => {}, pause: () => {}, resume: () => {}, emit: (d) => onData(d), exit: (code) => onExit({ exitCode: code }) }
}
function proc(): RegistryProc & { exit(code: number): void } {
  let onExit: (e: { exitCode: number }) => void = () => {}
  return { pid: 2, onData: () => {}, onExit: (cb) => { onExit = cb }, write: () => {}, kill: () => {}, exit: (code) => onExit({ exitCode: code }) }
}
const note = (id: string, over: Record<string, unknown> = {}) => ({ kind: 'session' as const, id, restore: { accountId: 'a1', cwd: 'D:/p', title: id, slackNotify: true, ...over } })
const opts = { cwd: 'D:/p', cols: 80, rows: 24, env: {} }

function rig(o: { active?: () => boolean } = {}) {
  const ptys = new Map<string, ReturnType<typeof pty>>()
  const procsMade = new Map<string, ReturnType<typeof proc>>()
  let next = ''
  const registry = new PtyRegistry({ spawn: () => { const p = pty(); ptys.set(next, p); return p }, log: () => {} })
  const procs = new ProcRegistry({ spawn: () => { const p = proc(); procsMade.set(next, p); return p }, log: () => {} })
  const records = new Map<string, SessionInfo>()
  const trail: string[] = []
  const noted: string[] = []
  const notifier = {
    has: (id: string) => records.has(id),
    register: (info: SessionInfo, o?: { thread?: { ts: string; channel: string } | null }) => { records.set(info.id, info); trail.push(`register ${info.id} ${o?.thread?.ts ?? '-'}`) },
    rename: (id: string, title: string) => trail.push(`rename ${id} ${title}`),
    handleData: (e: { sessionId: string }) => trail.push(`data ${e.sessionId}`),
    handleExit: (e: { sessionId: string; exitCode: number }) => { trail.push(`exit ${e.sessionId} ${e.exitCode}`) },
    adoptNoted: (id: string, t: { ts: string; channel: string } | null) => { trail.push(`adopt ${id} ${t?.ts ?? '-'}`) }
  }
  const s = createHostSlackSessions({
    registry,
    procs,
    notifier,
    log: () => {},
    onNoted: (info, restore) => noted.push(`noted ${info.id} ${String(restore.rolloutPath ?? '-')}`),
    ...(o.active ? { active: o.active } : {})
  })
  const openPty = (ptyId: string, m: ReturnType<typeof note>) => { next = ptyId; registry.open({ id: ptyId, file: 'x', args: [], opts, meta: m }) }
  const openChat = (procId: string, id: string, over: Record<string, unknown> = {}) => { next = procId; procs.open({ id: procId, file: 'x', args: [], opts: { cwd: 'D:/p', env: {} }, meta: { kind: 'chat', id, restore: { accountId: 'a1', cwd: 'D:/p', title: id, slackNotify: true, ...over } } }) }
  return { registry, procs, s, trail, noted, records, ptys, procsMade, openPty, openChat }
}

describe('createHostSlackSessions (Slack in the Host Task 5, spec §3.3, P7)', () => {
  it('registers a Slack session the moment its pty or proc opens, with its noted thread, and renames from its note', () => {
    const h = rig()
    h.openPty('p1', note('s1', { slackThreadTs: '1.2', slackChannel: 'C1' }))
    h.openPty('p2', note('s2', { slackNotify: false }))
    h.openChat('q1', 'c1')
    h.registry.note('p1', { title: 'renamed' })
    expect(h.trail).toEqual(['register s1 1.2', 'register c1 -', 'rename s1 renamed'])
  })

  // Review Focus 2.
  it('a rolled session\'s new pty opens no root of its own while the old one is registered', () => {
    const h = rig()
    h.openPty('p1', note('s1'))
    h.openPty('p2', note('s2', { rolledFrom: 's1' }))
    expect(h.trail).toEqual(['register s1 -'])
    h.s.reconcile()
    expect(h.trail.filter((t) => !t.startsWith('rename'))).toEqual(['register s1 -'])
    // The roll ends the old pty; its record's exit timer runs, and no roll event came.
    h.ptys.get('p1')!.exit(0)
    h.records.delete('s1')
    h.s.reconcile()
    expect(h.trail.filter((t) => !t.startsWith('rename'))).toEqual(['register s1 -', 'exit s1 0', 'register s2 -'])
  })

  // Slack in the Host e2e (Task 10): the Host hands a roll to its Slack the moment it sends it, so the old
  // proc (or pty) still lives for a moment after onRolled moved its record to the new id. Registered again
  // then, its exit posted "session ended" in the thread the new session carries on.
  it('the old entry of a roll is not registered again once the roll moved its record, however long it lingers', () => {
    const h = rig()
    h.openChat('q1', 'c1')
    h.openPty('p1', note('s1'))
    h.openChat('q2', 'c2', { rolledFrom: 'c1' })
    h.openPty('p2', note('s2', { rolledFrom: 's1' }))
    // onRolled: each record moves to its new id.
    for (const [from, to] of [['c1', 'c2'], ['s1', 's2']]) { h.records.set(to, h.records.get(from)!); h.records.delete(from) }
    h.procs.note('q1', { answered: ['r1'] })
    h.registry.note('p1', { title: 's1 again' })
    h.s.reconcile()
    h.s.reconcile({ fromNotes: true })
    expect(h.trail.filter((t) => t.startsWith('register'))).toEqual(['register c1 -', 'register s1 -'])
  })

  // Task 6 (the Task 5 carry): an activation's reconcile hands a known record its note's thread; the
  // rolling tick's does not. A known session's note change is told on (a codex rollout noted late).
  it('an activation reads the noted thread of a known record again, and a note change on a known session is told', () => {
    const h = rig()
    h.openPty('p1', note('s1', { slackThreadTs: '1.2', slackChannel: 'C1' }))
    h.registry.note('p1', { rolloutPath: 'D:/r.jsonl' })
    h.s.reconcile()
    expect(h.trail.filter((t) => t.startsWith('adopt'))).toEqual([])
    h.registry.note('p1', { slackThreadTs: '3.4' })
    h.s.reconcile({ fromNotes: true })
    expect(h.trail.filter((t) => t.startsWith('adopt'))).toEqual(['adopt s1 3.4'])
    expect(h.noted).toContain('noted s1 D:/r.jsonl')
  })

  it('feeds output, and an exit only when no other pty or proc carries the session on', () => {
    const h = rig()
    h.openPty('p1', note('s1'))
    h.ptys.get('p1')!.emit('hello')
    h.openPty('p1b', note('s1'))
    h.ptys.get('p1')!.exit(1)
    h.ptys.get('p1b')!.exit(0)
    h.openChat('q1', 'c1')
    h.procsMade.get('q1')!.exit(3)
    // The second pty of s1 finds the record and only renames it from its note.
    expect(h.trail.filter((t) => !t.startsWith('register') && !t.startsWith('rename'))).toEqual(['data s1', 'exit s1 0', 'exit c1 3'])
    expect(h.trail.filter((t) => t.startsWith('register'))).toEqual(['register s1 -', 'register c1 -'])
  })

  // The handover (Review Focus 4, the Host half): while an app keeps Slack its notifier opens the root and
  // notes it. A record the Host made then would hold no thread, and at activation it would post a second
  // root. So nothing is registered while inactive, and the activation's reconcile reads the note as it is.
  it('registers nothing while inactive, and the activation\'s reconcile takes the thread the app noted meanwhile', () => {
    let active = false
    const h = rig({ active: () => active })
    h.openPty('p1', note('s1'))
    h.registry.note('p1', { slackThreadTs: '9.9', slackChannel: 'C1' })
    expect(h.trail).toEqual([])
    active = true
    h.s.reconcile()
    expect(h.trail).toEqual(['register s1 9.9'])
  })

  it('hears nothing after dispose', () => {
    const h = rig()
    h.openPty('p1', note('s1'))
    h.s.dispose()
    h.ptys.get('p1')!.emit('x')
    h.registry.note('p1', { title: 'later' })
    h.openPty('p2', note('s2'))
    h.ptys.get('p1')!.exit(0)
    expect(h.trail).toEqual(['register s1 -'])
  })
})

import { describe, it, expect } from 'vitest'
import { appTab, sessionTab } from '../../../core/panes/tabId'
import { createGroup, leaves, type PaneNode } from '../../../core/panes/tree'
import { applyWorkspaceEvent, createSizeReporter, mirrorStatus, mirrorsFromList, newlyOpened, openSessionIds, placeAppTabs, removeAppTab, type Mirrors } from './workspaceMirror'

const frame = { jpeg: '/9j/', width: 4, height: 3, at: 1 }

describe('the mirror state', () => {
  it('opens on a state event, takes frames, and keeps the last frame when it closes', () => {
    let m: Mirrors = {}
    m = applyWorkspaceEvent(m, { kind: 'state', sessionId: 's1', open: true, running: true, helper: 'launch' })
    m = applyWorkspaceEvent(m, { kind: 'frame', sessionId: 's1', frame })
    expect(m.s1).toEqual({ sessionId: 's1', open: true, running: true, helper: 'launch', frame })
    m = applyWorkspaceEvent(m, { kind: 'state', sessionId: 's1', open: false, running: false, helper: null })
    expect(m.s1).toEqual({ sessionId: 's1', open: false, running: false, helper: null, frame })
  })

  // Stage 4, task 2: a long first build holds launch for minutes, and the mirror says so, with the
  // seconds the Host counts, rather than only "Running: launch".
  it('keeps how long the app has been starting while the Host says so, across frames, and drops it after', () => {
    let m: Mirrors = {}
    m = applyWorkspaceEvent(m, { kind: 'state', sessionId: 's1', open: true, running: true, helper: 'launch', launching: 12 })
    expect(m.s1.launching).toBe(12)
    m = applyWorkspaceEvent(m, { kind: 'frame', sessionId: 's1', frame })
    expect(m.s1.launching).toBe(12)
    expect(mirrorStatus(m.s1)).toEqual({ key: 'workspace.pane.launching', params: { seconds: 12 } })
    m = applyWorkspaceEvent(m, { kind: 'state', sessionId: 's1', open: true, running: true, helper: 'snapshot' })
    expect(m.s1).not.toHaveProperty('launching')
    expect(mirrorStatus(m.s1)).toEqual({ key: 'workspace.pane.running', params: { helper: 'snapshot' } })
    m = applyWorkspaceEvent(m, { kind: 'state', sessionId: 's1', open: true, running: false, helper: null, launching: 3 })
    expect(m.s1).not.toHaveProperty('launching')
    expect(mirrorStatus(m.s1)).toEqual({ key: 'workspace.pane.idle' })
    expect(mirrorStatus({ ...m.s1, open: false })).toEqual({ key: 'workspace.pane.closed' })
    expect(mirrorStatus(null)).toEqual({ key: 'workspace.pane.closed' })
    expect(mirrorStatus({ ...m.s1, running: true, helper: null })).toEqual({ key: 'workspace.pane.running', params: { helper: '...' } })
  })

  it('a frame for a session it has not heard of opens it', () => {
    expect(applyWorkspaceEvent({}, { kind: 'frame', sessionId: 's9', frame }).s9).toMatchObject({ open: true, frame })
  })

  it('says which sessions just opened, so each gets its tab once', () => {
    const a: Mirrors = {}
    const b = applyWorkspaceEvent(a, { kind: 'state', sessionId: 's1', open: true, running: false, helper: null })
    const c = applyWorkspaceEvent(b, { kind: 'state', sessionId: 's1', open: true, running: true, helper: 'click' })
    const d = applyWorkspaceEvent(c, { kind: 'state', sessionId: 's1', open: false, running: false, helper: null })
    const e = applyWorkspaceEvent(d, { kind: 'state', sessionId: 's1', open: true, running: false, helper: null })
    expect(newlyOpened(a, b)).toEqual(['s1'])
    expect(newlyOpened(b, c)).toEqual([])
    expect(newlyOpened(d, e)).toEqual(['s1'])
  })

  it('builds from a list', () => {
    expect(mirrorsFromList([{ sessionId: 's2', running: false, helper: null, frame: null }])).toEqual({
      s2: { sessionId: 's2', open: true, running: false, helper: null, frame: null }
    })
  })
})

const tabsOf = (root: PaneNode | null): string[] => (root ? leaves(root).flatMap((l) => l.tabIds) : [])

describe('placing the mirror tabs', () => {
  // Fix round 1 (Important): two workspaces that open before a render must both keep their tab.
  // Each placement builds on the previous one's tree, never on a tree the render has not caught up to.
  it('two sessions opened in one batch both get a tab, in the background', () => {
    const g = createGroup(sessionTab('s0'))
    const root = placeAppTabs(g, ['s1', 's2'], g.id)
    expect(tabsOf(root)).toEqual([sessionTab('s0'), appTab('s1'), appTab('s2')])
    expect(root && leaves(root)[0].activeTabId).toBe(sessionTab('s0'))
  })

  it('places onto an empty tree, and never places a tab twice', () => {
    const root = placeAppTabs(null, ['s1', 's1'], null)
    expect(tabsOf(root)).toEqual([appTab('s1')])
    expect(tabsOf(placeAppTabs(root, ['s1'], null))).toEqual([appTab('s1')])
    expect(placeAppTabs(null, [], null)).toBeNull()
  })

  it('names only the sessions whose workspace is open', () => {
    const m: Mirrors = {
      ...mirrorsFromList([{ sessionId: 's1', running: false, helper: null, frame: null }]),
      s2: { sessionId: 's2', open: false, running: false, helper: null, frame: null }
    }
    expect(openSessionIds(m)).toEqual(['s1'])
  })

  // Fix round 1 (minor): closing a session takes its mirror tab with it.
  it('removes a session mirror tab, and leaves a tree without one alone', () => {
    const root = placeAppTabs(createGroup(sessionTab('s1')), ['s1'], null)
    expect(tabsOf(removeAppTab(root, 's1'))).toEqual([sessionTab('s1')])
    const plain = createGroup(sessionTab('s1'))
    expect(removeAppTab(plain, 's1')).toBe(plain)
    expect(removeAppTab(null, 's1')).toBeNull()
  })
})

describe('createSizeReporter', () => {
  const rigReporter = () => {
    const sent: Array<{ width: number; height: number } | null> = []
    const timers: Array<{ fn: () => void; live: boolean }> = []
    const r = createSizeReporter((s) => sent.push(s), {
      set: (fn) => {
        const t = { fn, live: true }
        timers.push(t)
        return t
      },
      clear: (h) => {
        ;(h as { live: boolean }).live = false
      }
    })
    const fire = (): void => {
      for (const t of timers.splice(0)) if (t.live) t.fn()
    }
    return { r, sent, fire }
  }

  it('sends the size once a resize has settled: the last of a burst, clamped', () => {
    const { r, sent, fire } = rigReporter()
    r.measured({ width: 900, height: 600 })
    r.measured({ width: 1100, height: 650 })
    r.measured({ width: 1577.6, height: 988.4 })
    expect(sent).toEqual([])
    fire()
    expect(sent).toEqual([{ width: 1578, height: 988 }])
  })

  it('sends nothing for the size it last sent, or for a hidden tab', () => {
    const { r, sent, fire } = rigReporter()
    r.measured({ width: 1200, height: 700 })
    fire()
    r.measured({ width: 1200.3, height: 700 })
    fire()
    r.measured({ width: 0, height: 0 })
    fire()
    expect(sent).toEqual([{ width: 1200, height: 700 }])
  })

  it('a closed tab takes its size back, and one that never sent one sends nothing', () => {
    const a = rigReporter()
    a.r.measured({ width: 1200, height: 700 })
    a.fire()
    a.r.dispose()
    expect(a.sent).toEqual([{ width: 1200, height: 700 }, null])
    const b = rigReporter()
    b.r.measured({ width: 1200, height: 700 })
    b.r.dispose()
    b.fire()
    expect(b.sent).toEqual([])
  })
})

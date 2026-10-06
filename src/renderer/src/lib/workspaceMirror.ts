// The mirror tabs' state: one entry per session the Host has shown a workspace for. Pure, so it is
// tested without a window. A closed workspace keeps its entry (and last frame) until its tab closes:
// the person sees "closed" rather than a tab that vanished (agent workspace plan ruling P7).
import type { WorkspaceEvent, WorkspaceFrame, WorkspaceSummary } from '../../../core/host/protocol'
import { placeTab } from '../../../core/panes/place'
import { appTab } from '../../../core/panes/tabId'
import { groupOfTab, removeTab, type PaneNode } from '../../../core/panes/tree'
import { SIZE_REPORT_DEBOUNCE_MS, clampAppSize, sizeToReport, type AppSize } from '../../../core/workspace/size'

export interface MirrorEntry {
  sessionId: string
  open: boolean
  running: boolean
  helper: string | null
  frame: WorkspaceFrame | null
  /** Seconds the running script's launch has waited for the app so far; absent when it is not waiting. */
  launching?: number
}

export type Mirrors = Record<string, MirrorEntry>

export function applyWorkspaceEvent(prev: Mirrors, e: WorkspaceEvent): Mirrors {
  const was = prev[e.sessionId]
  if (e.kind === 'frame') {
    const launching = was?.launching !== undefined ? { launching: was.launching } : {}
    return { ...prev, [e.sessionId]: { sessionId: e.sessionId, open: true, running: was?.running ?? false, helper: was?.helper ?? null, frame: e.frame, ...launching } }
  }
  const running = e.open && e.running
  const launching = running && e.launching !== undefined ? { launching: e.launching } : {}
  return {
    ...prev,
    [e.sessionId]: { sessionId: e.sessionId, open: e.open, running, helper: e.open ? e.helper : null, frame: was?.frame ?? null, ...launching }
  }
}

/** The mirror bar's status line, as a message key and its parameters: the app starting (with the
 *  seconds the Host counts), a helper running, idle, or closed. */
export function mirrorStatus(
  m: MirrorEntry | null
):
  | { key: 'workspace.pane.launching'; params: { seconds: number } }
  | { key: 'workspace.pane.running'; params: { helper: string } }
  | { key: 'workspace.pane.idle' | 'workspace.pane.closed' } {
  if (m?.running && m.launching !== undefined) return { key: 'workspace.pane.launching', params: { seconds: m.launching } }
  if (m?.running) return { key: 'workspace.pane.running', params: { helper: m.helper ?? '...' } }
  return { key: m?.open === true ? 'workspace.pane.idle' : 'workspace.pane.closed' }
}

export function mirrorsFromList(list: WorkspaceSummary[]): Mirrors {
  const out: Mirrors = {}
  for (const w of list) out[w.sessionId] = { sessionId: w.sessionId, open: true, running: w.running, helper: w.helper, frame: w.frame }
  return out
}

export interface SizeReporter {
  /** The mirror stage's content box as measured now, in CSS pixels. */
  measured(size: { width: number; height: number }): void
  /** The tab is going: a size that was sent is taken back (`null`), so the next launch takes the
   *  default size rather than a tab nobody looks at. */
  dispose(): void
}

export interface ReporterTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: ReporterTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>)
}

/** The mirror tab's size, sent to the Host once a resize has settled for `delayMs`, and only when it
 *  changed (sizeToReport): a splitter dragged across the window resizes the app once, at the end. */
export function createSizeReporter(send: (size: AppSize | null) => void, timers: ReporterTimers = realTimers, delayMs = SIZE_REPORT_DEBOUNCE_MS): SizeReporter {
  let last: AppSize | null = null
  let pending: { width: number; height: number } | null = null
  let timer: unknown = null
  const flush = (): void => {
    timer = null
    if (pending === null) return
    const next = sizeToReport(last, pending)
    pending = null
    if (next === null) return
    last = next
    send(next)
  }
  return {
    measured: (size) => {
      // A hidden pane measures 0 by 0: it neither sends nor cancels a size on its way.
      if (clampAppSize(size) === null) return
      pending = size
      if (timer !== null) timers.clear(timer)
      timer = timers.set(flush, delayMs)
    },
    dispose: () => {
      if (timer !== null) timers.clear(timer)
      timer = null
      pending = null
      if (last !== null) send(null)
      last = null
    }
  }
}

export interface SessionSizeReporters {
  /** A mirror pane for `sessionId` appeared: its measurements go to that session's one reporter, so
   *  the pane resized last sets the size. `release` when the pane goes; the session's size is taken
   *  back (null) only when its last pane goes. */
  acquire(sessionId: string): { measured(size: { width: number; height: number }): void; release(): void }
}

/** One size reporter per session, shared by every pane that mirrors it (a session's mirror tab can
 *  show in more than one pane group), counted so the size is withdrawn only with the last of them. */
export function createSessionSizeReporters(
  send: (sessionId: string, size: AppSize | null) => void,
  timers: ReporterTimers = realTimers,
  delayMs = SIZE_REPORT_DEBOUNCE_MS
): SessionSizeReporters {
  const live = new Map<string, { reporter: SizeReporter; panes: number }>()
  return {
    acquire: (sessionId) => {
      let e = live.get(sessionId)
      if (!e) {
        e = { reporter: createSizeReporter((s) => send(sessionId, s), timers, delayMs), panes: 0 }
        live.set(sessionId, e)
      }
      const entry = e
      entry.panes += 1
      let released = false
      return {
        measured: (size) => {
          if (!released) entry.reporter.measured(size)
        },
        release: () => {
          if (released) return
          released = true
          entry.panes -= 1
          if (entry.panes > 0) return
          entry.reporter.dispose()
          if (live.get(sessionId) === entry) live.delete(sessionId)
        }
      }
    }
  }
}

/** Sessions that are open in `next` and were not open in `prev`: each gets its tab placed once. */
export function newlyOpened(prev: Mirrors, next: Mirrors): string[] {
  return Object.values(next)
    .filter((m) => m.open && prev[m.sessionId]?.open !== true)
    .map((m) => m.sessionId)
}

/** Sessions whose workspace is open now: the mirror tabs a freshly built tree must carry. */
export function openSessionIds(m: Mirrors): string[] {
  return Object.values(m)
    .filter((e) => e.open)
    .map((e) => e.sessionId)
}

/** Places each session's mirror tab in the background (the openAgentTab rule: the agent's work must not
 *  take the tab the person is on), each placement building on the previous one's tree, so two
 *  workspaces that open before a render both keep their tab. A tab already in the tree is left alone. */
export function placeAppTabs(root: PaneNode | null, sessionIds: string[], activePaneId: string | null): PaneNode | null {
  let next = root
  for (const sid of sessionIds) {
    const id = appTab(sid)
    if (next && groupOfTab(next, id)) continue
    next = placeTab(next, id, { activePaneId, background: true }).root
  }
  return next
}

/** The tree without the session's mirror tab: a closed session leaves no mirror behind. */
export function removeAppTab(root: PaneNode | null, sessionId: string): PaneNode | null {
  const id = appTab(sessionId)
  return root && groupOfTab(root, id) ? removeTab(root, id) : root
}

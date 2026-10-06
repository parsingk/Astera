// The app's view of the Host's agent app workspaces (agent workspace design, Mirror tab). A Host that
// announced `workspace` pushes `workspace` events to this app because its hello yields `workspace`;
// this keeps the latest per session, forwards each to the window, asks for the live ones after every
// handshake (an app that attaches later), and closes every tab when the connection goes. It never
// throws, the hostDriver.ts rule. ipc.ts only wires it.
import { HOST_FEATURE_WORKSPACE, HOST_FEATURE_WORKSPACE_SIZE, type HostMessage, type WorkspaceEvent, type WorkspaceFrame, type WorkspaceSummary } from '../../core/host/protocol'
import type { AppSize } from '../../core/workspace/size'

export interface HostWorkspaceView {
  pushed(m: HostMessage): void
  connected(): Promise<void>
  status(s: { connected: boolean; unresponsive: boolean }): void
  current(): WorkspaceSummary[]
  stop(sessionId: string): Promise<boolean>
  close(sessionId: string): Promise<boolean>
  /** The mirror tab's size in CSS pixels, or null when the tab closed (HOST_FEATURE_WORKSPACE_SIZE).
   *  False when the Host cannot size its app windows, or refused. */
  size(sessionId: string, size: AppSize | null): Promise<boolean>
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function frameOf(v: unknown): WorkspaceFrame | null {
  if (!isRecord(v) || typeof v.jpeg !== 'string' || typeof v.width !== 'number' || typeof v.height !== 'number' || typeof v.at !== 'number') return null
  return { jpeg: v.jpeg, width: v.width, height: v.height, at: v.at }
}

/** The event a push carries, or null when it is not one this app can read. */
function eventOf(v: unknown): WorkspaceEvent | null {
  if (!isRecord(v) || typeof v.sessionId !== 'string' || v.sessionId === '') return null
  if (v.kind === 'state' && typeof v.open === 'boolean' && typeof v.running === 'boolean' && (v.helper === null || typeof v.helper === 'string')) {
    // How long the app has been starting (stage 4, task 2): carried only when it is a count.
    const launching = typeof v.launching === 'number' && Number.isFinite(v.launching) && v.launching >= 0 ? { launching: v.launching } : {}
    return { kind: 'state', sessionId: v.sessionId, open: v.open, running: v.running, helper: v.helper, ...launching }
  }
  if (v.kind === 'frame') {
    const frame = frameOf(v.frame)
    return frame ? { kind: 'frame', sessionId: v.sessionId, frame } : null
  }
  return null
}

export function createHostWorkspaceView(d: {
  status(): { features: readonly string[] }
  call(m: { cmd: string; args: Record<string, unknown>; sessionId: string }): Promise<{ status: number; body: unknown }>
  changed(e: WorkspaceEvent): void
  log(m: string): void
}): HostWorkspaceView {
  const live = new Map<string, WorkspaceSummary>()
  /** Each mirror's last size, kept here because the Host keeps its copy in memory only: a Host that
   *  replaced the last one, or that announced workspace-size only at the handshake after the tab
   *  measured, hears every one again from `connected()`. */
  const sizes = new Map<string, AppSize>()
  const has = (feature: string = HOST_FEATURE_WORKSPACE): boolean => {
    try {
      const features = d.status().features
      return features.includes(HOST_FEATURE_WORKSPACE) && features.includes(feature)
    } catch {
      return false
    }
  }
  const tell = (e: WorkspaceEvent): void => {
    try {
      d.changed(e)
    } catch (err) {
      d.log(`host: a workspace event could not be told to the window: ${String(err)}`)
    }
  }
  const apply = (e: WorkspaceEvent): void => {
    if (e.kind === 'state') {
      if (!e.open) live.delete(e.sessionId)
      else live.set(e.sessionId, { sessionId: e.sessionId, running: e.running, helper: e.helper, frame: live.get(e.sessionId)?.frame ?? null })
    } else {
      const prev = live.get(e.sessionId)
      live.set(e.sessionId, { sessionId: e.sessionId, running: prev?.running ?? false, helper: prev?.helper ?? null, frame: e.frame })
    }
    tell(e)
  }
  const closeAll = (): void => {
    for (const id of [...live.keys()]) apply({ kind: 'state', sessionId: id, open: false, running: false, helper: null })
  }
  const button = async (cmd: 'workspace-stop' | 'workspace-close', sessionId: string, field: 'stopped' | 'closed'): Promise<boolean> => {
    if (!has()) return false
    try {
      const r = await d.call({ cmd, args: { sessionId }, sessionId: '' })
      return r.status === 200 && isRecord(r.body) && r.body[field] === true
    } catch (err) {
      d.log(`host: ${cmd} failed: ${String(err)}`)
      return false
    }
  }
  const sendSize = async (sessionId: string, size: AppSize | null): Promise<boolean> => {
    if (!has(HOST_FEATURE_WORKSPACE_SIZE)) return false
    try {
      const r = await d.call({ cmd: 'workspace-size', args: { sessionId, size }, sessionId: '' })
      return r.status === 200
    } catch (err) {
      d.log(`host: workspace-size failed: ${String(err)}`)
      return false
    }
  }
  return {
    pushed: (m) => {
      try {
        if (m?.t !== 'workspace' || !has()) return
        const e = eventOf((m as { event?: unknown }).event)
        if (e) apply(e)
        else d.log('host: a workspace push the app could not read was dropped')
      } catch (err) {
        d.log(`host: a workspace push could not be read: ${String(err)}`)
      }
    },
    connected: async () => {
      try {
        if (!has()) return closeAll()
        const r = await d.call({ cmd: 'workspace-list', args: {}, sessionId: '' })
        const list = r.status === 200 && isRecord(r.body) && Array.isArray(r.body.workspaces) ? r.body.workspaces : []
        const next = new Map<string, WorkspaceSummary>()
        for (const w of list) {
          if (!isRecord(w) || typeof w.sessionId !== 'string') continue
          next.set(w.sessionId, { sessionId: w.sessionId, running: w.running === true, helper: typeof w.helper === 'string' ? w.helper : null, frame: frameOf(w.frame) })
        }
        for (const id of [...live.keys()]) if (!next.has(id)) apply({ kind: 'state', sessionId: id, open: false, running: false, helper: null })
        for (const w of next.values()) {
          apply({ kind: 'state', sessionId: w.sessionId, open: true, running: w.running, helper: w.helper })
          if (w.frame) apply({ kind: 'frame', sessionId: w.sessionId, frame: w.frame })
        }
      } catch (err) {
        d.log(`host: workspace-list failed: ${String(err)}`)
      }
      // Every mirror's size again: this Host may be a new one, or one that announced workspace-size
      // only now. sendSize never throws, and asks nothing of a Host without the feature.
      for (const [sessionId, size] of [...sizes]) await sendSize(sessionId, size)
    },
    status: (s) => {
      try {
        if (!s.connected && !s.unresponsive) closeAll()
      } catch (err) {
        d.log(`host: the workspaces could not follow a status change: ${String(err)}`)
      }
    },
    current: () => [...live.values()].map((w) => ({ ...w })),
    stop: (sessionId) => button('workspace-stop', sessionId, 'stopped'),
    close: (sessionId) => button('workspace-close', sessionId, 'closed'),
    size: async (sessionId, size) => {
      if (size === null) sizes.delete(sessionId)
      else sizes.set(sessionId, size)
      return sendSize(sessionId, size)
    }
  }
}

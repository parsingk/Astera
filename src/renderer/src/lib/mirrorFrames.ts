// The mirror tabs' frames, outside App's state (second pass R2-2, R2-3). A workspace sends a frame every second while it
// runs; held in App's state, each one drew App and every pane under it again, mirror tab showing or not, and the last
// full-size JPEG of every session that ever opened a workspace stayed for the app's life. Here a frame reaches only the
// mirror pane that reads it (useSyncExternalStore), and goes when its tab closes or its session goes.
import type { WorkspaceEvent, WorkspaceFrame } from '../../../core/host/protocol'
import { applyWorkspaceEvent, type Mirrors } from './workspaceMirror'

export interface FrameStore {
  get(sessionId: string): WorkspaceFrame | null
  set(sessionId: string, frame: WorkspaceFrame): void
  drop(sessionIds: Iterable<string>): void
  /** Called on every change of this session's frame; the returned function stops it. */
  subscribe(sessionId: string, cb: () => void): () => void
}

export function createFrameStore(): FrameStore {
  const frames = new Map<string, WorkspaceFrame>()
  const listeners = new Map<string, Set<() => void>>()
  const tell = (id: string): void => {
    for (const cb of [...(listeners.get(id) ?? [])]) cb()
  }
  return {
    get: (id) => frames.get(id) ?? null,
    set: (id, frame) => {
      frames.set(id, frame)
      tell(id)
    },
    drop: (ids) => {
      for (const id of ids) if (frames.delete(id)) tell(id)
    },
    subscribe: (id, cb) => {
      let set = listeners.get(id)
      if (!set) listeners.set(id, (set = new Set()))
      set.add(cb)
      return () => {
        set.delete(cb)
        if (set.size === 0 && listeners.get(id) === set) listeners.delete(id)
      }
    }
  }
}

/** The app's one store, read by AppMirrorPane. */
export const mirrorFrames = createFrameStore()

/** `applyWorkspaceEvent` with the frames held in `frames`: a frame for a workspace already open changes no state (the
 *  same object comes back), and no entry holds a frame. */
export function takeWorkspaceEvent(prev: Mirrors, e: WorkspaceEvent, frames: FrameStore): Mirrors {
  if (e.kind !== 'frame') return applyWorkspaceEvent(prev, e)
  frames.set(e.sessionId, e.frame)
  if (prev[e.sessionId]?.open === true) return prev
  const next = applyWorkspaceEvent(prev, e)
  return { ...next, [e.sessionId]: { ...next[e.sessionId], frame: null } }
}

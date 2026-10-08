// Second pass R2-2, R2-3: a workspace's frame came every second and lived in App's state, so App and every pane under
// it drew again each second while any workspace ran, mirror tab showing or not; and the last full-size JPEG of every
// session that ever opened a workspace was kept for the app's life.
import { describe, it, expect } from 'vitest'
import { createFrameStore, takeWorkspaceEvent } from './mirrorFrames'
import type { WorkspaceFrame } from '../../../core/host/protocol'

const frame = (n: number): WorkspaceFrame => ({ jpeg: `j${n}`, width: 10, height: 10 }) as WorkspaceFrame

describe('the mirror frame store', () => {
  it('a frame for an open workspace changes no App state, and reaches only that session’s listeners', () => {
    const frames = createFrameStore()
    let heard = 0
    let other = 0
    frames.subscribe('s1', () => void heard++)
    frames.subscribe('s2', () => void other++)
    const open = takeWorkspaceEvent({}, { kind: 'state', sessionId: 's1', open: true, running: true, helper: null } as never, frames)
    const after = takeWorkspaceEvent(open, { kind: 'frame', sessionId: 's1', frame: frame(1) } as never, frames)
    expect(after).toBe(open)
    expect(frames.get('s1')).toEqual(frame(1))
    expect(heard).toBe(1)
    expect(other).toBe(0)
  })

  it('a frame for a session not open yet opens it, holding no frame in the state', () => {
    const frames = createFrameStore()
    const next = takeWorkspaceEvent({}, { kind: 'frame', sessionId: 's1', frame: frame(1) } as never, frames)
    expect(next.s1).toMatchObject({ open: true, frame: null })
    expect(frames.get('s1')).toEqual(frame(1))
  })

  it('drops the frames of sessions that went, and tells their listeners', () => {
    const frames = createFrameStore()
    let heard = 0
    frames.set('s1', frame(1))
    frames.set('s2', frame(2))
    frames.subscribe('s1', () => void heard++)
    frames.drop(['s1'])
    expect(frames.get('s1')).toBeNull()
    expect(frames.get('s2')).toEqual(frame(2))
    expect(heard).toBe(1)
  })

  it('stops telling a listener that unsubscribed', () => {
    const frames = createFrameStore()
    let heard = 0
    const off = frames.subscribe('s1', () => void heard++)
    off()
    frames.set('s1', frame(1))
    expect(heard).toBe(0)
  })
})

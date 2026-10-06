import { describe, it, expect, vi } from 'vitest'
import { HOST_FEATURE_WORKSPACE, HOST_FEATURE_WORKSPACE_SIZE, type WorkspaceEvent } from '../../core/host/protocol'
import { createHostWorkspaceView } from './hostWorkspace'

const frame = { jpeg: '/9j/', width: 10, height: 8, at: 1 }

const rig = (features: string[] = [HOST_FEATURE_WORKSPACE]) => {
  const changed: WorkspaceEvent[] = []
  const call = vi.fn(async (m: { cmd: string; args: Record<string, unknown> }) => {
    if (m.cmd === 'workspace-list') return { status: 200, body: { workspaces: [{ sessionId: 's2', running: true, helper: 'click', frame }] } }
    if (m.cmd === 'workspace-stop') return { status: 200, body: { stopped: true } }
    return { status: 200, body: { closed: true } }
  })
  const logs: string[] = []
  const view = createHostWorkspaceView({ status: () => ({ features }), call, changed: (e) => changed.push(e), log: (m) => logs.push(m) })
  return { view, changed, call, logs }
}

describe('createHostWorkspaceView', () => {
  it('forwards a push from a Host that announced workspace, and keeps the latest per session', () => {
    const { view, changed } = rig()
    view.pushed({ t: 'workspace', event: { kind: 'state', sessionId: 's1', open: true, running: true, helper: 'launch' } })
    view.pushed({ t: 'workspace', event: { kind: 'frame', sessionId: 's1', frame } })
    expect(changed).toHaveLength(2)
    expect(view.current()).toEqual([{ sessionId: 's1', running: true, helper: 'launch', frame }])
    view.pushed({ t: 'workspace', event: { kind: 'state', sessionId: 's1', open: false, running: false, helper: null } })
    expect(view.current()).toEqual([])
  })

  // Stage 4, task 2: while a launch waits for the app, the Host's state says for how many seconds.
  it('carries how long the app has been starting, and leaves out a count it cannot read', () => {
    const { view, changed } = rig()
    view.pushed({ t: 'workspace', event: { kind: 'state', sessionId: 's1', open: true, running: true, helper: 'launch', launching: 7 } })
    view.pushed({ t: 'workspace', event: { kind: 'state', sessionId: 's1', open: true, running: true, helper: 'launch', launching: 'soon' } } as never)
    view.pushed({ t: 'workspace', event: { kind: 'state', sessionId: 's1', open: true, running: true, helper: 'launch', launching: -1 } } as never)
    expect(changed).toEqual([
      { kind: 'state', sessionId: 's1', open: true, running: true, helper: 'launch', launching: 7 },
      { kind: 'state', sessionId: 's1', open: true, running: true, helper: 'launch' },
      { kind: 'state', sessionId: 's1', open: true, running: true, helper: 'launch' }
    ])
  })

  it('drops a push from a Host that did not announce it, and a push it cannot read', () => {
    const quiet = rig([])
    quiet.view.pushed({ t: 'workspace', event: { kind: 'state', sessionId: 's1', open: true, running: false, helper: null } })
    expect(quiet.changed).toEqual([])
    const { view, changed, logs } = rig()
    view.pushed({ t: 'workspace', event: { kind: 'frame', sessionId: 's1', frame: { jpeg: 5 } } } as never)
    expect(changed).toEqual([])
    expect(logs.some((l) => l.includes('could not read'))).toBe(true)
  })

  it('an app that attaches later asks for the live workspaces, and closes the ones that are gone', async () => {
    const { view, changed, call } = rig()
    view.pushed({ t: 'workspace', event: { kind: 'state', sessionId: 's1', open: true, running: false, helper: null } })
    changed.length = 0
    await view.connected()
    expect(call).toHaveBeenCalledWith({ cmd: 'workspace-list', args: {}, sessionId: '' })
    expect(changed).toEqual([
      { kind: 'state', sessionId: 's1', open: false, running: false, helper: null },
      { kind: 'state', sessionId: 's2', open: true, running: true, helper: 'click' },
      { kind: 'frame', sessionId: 's2', frame }
    ])
  })

  it('asks nothing of a Host without the feature, and a lost connection closes every tab', async () => {
    const quiet = rig([])
    await quiet.view.connected()
    expect(quiet.call).not.toHaveBeenCalled()
    expect(await quiet.view.stop('s1')).toBe(false)
    const { view, changed } = rig()
    view.pushed({ t: 'workspace', event: { kind: 'state', sessionId: 's1', open: true, running: false, helper: null } })
    view.status({ connected: false, unresponsive: false })
    expect(changed.at(-1)).toEqual({ kind: 'state', sessionId: 's1', open: false, running: false, helper: null })
    expect(view.current()).toEqual([])
  })

  it('Stop and Close go to the Host', async () => {
    const { view, call } = rig()
    expect(await view.stop('s1')).toBe(true)
    expect(await view.close('s1')).toBe(true)
    expect(call).toHaveBeenCalledWith({ cmd: 'workspace-stop', args: { sessionId: 's1' }, sessionId: '' })
    expect(call).toHaveBeenCalledWith({ cmd: 'workspace-close', args: { sessionId: 's1' }, sessionId: '' })
  })

  it('the mirror tab size goes to a Host that sizes app windows, and to no other', async () => {
    const { view, call } = rig([HOST_FEATURE_WORKSPACE, HOST_FEATURE_WORKSPACE_SIZE])
    expect(await view.size('s1', { width: 1400, height: 900 })).toBe(true)
    expect(call).toHaveBeenCalledWith({ cmd: 'workspace-size', args: { sessionId: 's1', size: { width: 1400, height: 900 } }, sessionId: '' })
    expect(await view.size('s1', null)).toBe(true)
    expect(call).toHaveBeenLastCalledWith({ cmd: 'workspace-size', args: { sessionId: 's1', size: null }, sessionId: '' })
    const older = rig()
    expect(await older.view.size('s1', { width: 1400, height: 900 })).toBe(false)
    expect(older.call).not.toHaveBeenCalled()
    const failing = rig([HOST_FEATURE_WORKSPACE, HOST_FEATURE_WORKSPACE_SIZE])
    failing.call.mockRejectedValueOnce(new Error('gone'))
    expect(await failing.view.size('s1', null)).toBe(false)
    expect(failing.logs.some((l) => l.includes('workspace-size failed'))).toBe(true)
  })

  it('every mirror size is sent again after each handshake: a Host that announced the feature late, or a new Host', async () => {
    const features: string[] = [HOST_FEATURE_WORKSPACE]
    const changed: WorkspaceEvent[] = []
    const call = vi.fn(async (m: { cmd: string; args: Record<string, unknown> }) =>
      m.cmd === 'workspace-list' ? { status: 200, body: { workspaces: [] } } : { status: 200, body: { sized: true } }
    )
    const view = createHostWorkspaceView({ status: () => ({ features }), call, changed: (e) => changed.push(e), log: () => {} })
    // Measured before the Host said it sizes app windows: nothing sent, but kept.
    expect(await view.size('s1', { width: 1400, height: 900 })).toBe(false)
    expect(await view.size('s2', { width: 800, height: 600 })).toBe(false)
    expect(await view.size('s2', null)).toBe(false)
    features.push(HOST_FEATURE_WORKSPACE_SIZE)
    await view.connected()
    const sized = () => call.mock.calls.map((c) => c[0]).filter((m) => m.cmd === 'workspace-size')
    expect(sized()).toEqual([{ cmd: 'workspace-size', args: { sessionId: 's1', size: { width: 1400, height: 900 } }, sessionId: '' }])
    // The Host was replaced: its sizes are gone with it, and the app sends them again.
    await view.connected()
    expect(sized()).toHaveLength(2)
    // A list that fails still resends.
    call.mockRejectedValueOnce(new Error('gone'))
    await view.connected()
    expect(sized()).toHaveLength(3)
  })

  it('a list call that fails is logged, never thrown', async () => {
    const { view, call, logs } = rig()
    call.mockRejectedValueOnce(new Error('APP_REQUIRED'))
    await expect(view.connected()).resolves.toBeUndefined()
    expect(logs.some((l) => l.includes('workspace-list'))).toBe(true)
  })
})

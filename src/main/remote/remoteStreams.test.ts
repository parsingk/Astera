// A remote session tab's output (remote runtime design Phase 9b): main subscribes to the Runtime's pty through that
// Runtime's client and forwards it to the renderer under the tab's key, `<runtimeId>:<sessionId>`.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRemoteStreams } from './remoteStreams'
import type { PtyStreamHandlers } from '../../core/remote/link'

function fakeClient() {
  const subs: Array<{ pty: string; h: PtyStreamHandlers; stopped: boolean }> = []
  return {
    subs,
    client: {
      subscribePty: (pty: string, h: PtyStreamHandlers) => {
        const s = { pty, h, stopped: false }
        subs.push(s)
        return () => void (s.stopped = true)
      }
    }
  }
}

function rig() {
  const sent: Array<[string, unknown]> = []
  const clients = new Map<string, ReturnType<typeof fakeClient>>([['rt_1', fakeClient()]])
  const streams = createRemoteStreams({
    clientOf: async (id) => clients.get(id)?.client ?? { code: 'RUNTIME_NOT_FOUND', message: `no runtime ${id}` },
    send: (channel, payload) => void sent.push([channel, payload])
  })
  return { sent, clients, streams, rt: () => clients.get('rt_1')! }
}

describe('createRemoteStreams', () => {
  it('forwards a checkpoint as a reset and events as data, size and exit, under the tab key', async () => {
    const r = rig()
    expect(await r.streams.attach('rt_1', 's1', 'pty-1')).toBe(true)
    const h = r.rt().subs[0].h
    h.onReset({ watermark: 3, cols: 100, rows: 30, state: 'S', pending: 'P' })
    h.onEvents([
      { seq: 4, kind: 'data', data: 'a' },
      { seq: 5, kind: 'data', data: 'b' },
      { seq: 6, kind: 'resize', cols: 90, rows: 20 },
      { seq: 7, kind: 'data', data: 'c' },
      { seq: 8, kind: 'exit', code: 0 }
    ])
    expect(r.sent).toEqual([
      ['session:reset', { sessionId: 'rt_1:s1', state: 'S', pending: 'P', cols: 100, rows: 30 }],
      ['session:data', { sessionId: 'rt_1:s1', data: 'ab' }],
      ['session:remote-size', { sessionId: 'rt_1:s1', cols: 90, rows: 20 }],
      ['session:data', { sessionId: 'rt_1:s1', data: 'c' }],
      ['session:remote-exit', { sessionId: 'rt_1:s1', code: 0 }]
    ])
  })

  it('a checkpoint of an ended pty carries its exit code', async () => {
    const r = rig()
    await r.streams.attach('rt_1', 's1', 'pty-1')
    r.rt().subs[0].h.onReset({ watermark: 3, cols: 80, rows: 24, state: '', pending: '', exitCode: 2 })
    expect(r.sent[0]).toEqual(['session:reset', { sessionId: 'rt_1:s1', state: '', pending: '', cols: 80, rows: 24, exitCode: 2 }])
  })

  it('a stream the Runtime gives up is reported gone', async () => {
    const r = rig()
    await r.streams.attach('rt_1', 's1', 'pty-1')
    r.rt().subs[0].h.onGone?.('RUNTIME_PTY_NOT_FOUND', 'no such pty')
    expect(r.sent).toEqual([['session:remote-gone', { sessionId: 'rt_1:s1', code: 'RUNTIME_PTY_NOT_FOUND', message: 'no such pty' }]])
  })

  // Phase 9b review I2: a stream kept past a renderer reload must not hand the new view a tail with no checkpoint before
  // it. Attaching again subscribes afresh, so a checkpoint comes first; one subscription stays live.
  it('attaching the same pty again subscribes afresh with one live; another pty (a roll) replaces it', async () => {
    const r = rig()
    await r.streams.attach('rt_1', 's1', 'pty-1')
    await r.streams.attach('rt_1', 's1', 'pty-1')
    expect(r.rt().subs.map((s) => [s.pty, s.stopped])).toEqual([
      ['pty-1', true],
      ['pty-1', false]
    ])
    await r.streams.attach('rt_1', 's1', 'pty-2')
    expect(r.rt().subs.map((s) => [s.pty, s.stopped])).toEqual([
      ['pty-1', true],
      ['pty-1', true],
      ['pty-2', false]
    ])
    // The old stream's late output is not forwarded.
    r.rt().subs[0].h.onEvents([{ seq: 9, kind: 'data', data: 'late' }])
    expect(r.sent).toEqual([])
  })

  it('detach unsubscribes; an unknown Runtime is not attached and says why', async () => {
    const r = rig()
    await r.streams.attach('rt_1', 's1', 'pty-1')
    r.streams.detach('rt_1:s1')
    expect(r.rt().subs[0].stopped).toBe(true)
    expect(await r.streams.attach('rt_x', 's1', 'pty-1')).toBe(false)
    expect(r.sent).toEqual([['session:remote-gone', { sessionId: 'rt_x:s1', code: 'RUNTIME_NOT_FOUND', message: 'no runtime rt_x' }]])
  })

  it('a re-paired Runtime gets its streams subscribed again on its new client; a removed one reports them gone', async () => {
    const r = rig()
    await r.streams.attach('rt_1', 's1', 'pty-1')
    const old = r.rt()
    r.clients.set('rt_1', fakeClient())
    await r.streams.rebind('rt_1')
    expect(old.subs[0].stopped).toBe(true)
    expect(r.rt().subs.map((s) => s.pty)).toEqual(['pty-1'])
    r.clients.delete('rt_1')
    await r.streams.rebind('rt_1')
    expect(r.sent.at(-1)).toEqual(['session:remote-gone', { sessionId: 'rt_1:s1', code: 'RUNTIME_NOT_FOUND', message: 'no runtime rt_1' }])
  })

  it('a detach while the client is still being found leaves nothing subscribed', async () => {
    const r = rig()
    const attaching = r.streams.attach('rt_1', 's1', 'pty-1')
    r.streams.detach('rt_1:s1')
    expect(await attaching).toBe(false)
    expect(r.rt().subs.every((s) => s.stopped)).toBe(true)
  })

  it('forwards a dropped and a restored connection as the tab’s link state', async () => {
    const r = rig()
    await r.streams.attach('rt_1', 's1', 'pty-1')
    r.rt().subs[0].h.onLinkState?.('down')
    r.rt().subs[0].h.onLinkState?.('up')
    expect(r.sent).toEqual([
      ['session:remote-link', { sessionId: 'rt_1:s1', state: 'down' }],
      ['session:remote-link', { sessionId: 'rt_1:s1', state: 'up' }]
    ])
  })

  // Phase 9b review I2: a reload drops every remote tab from the new renderer, so their streams are closed with the
  // old document, as the conversation sessions are.
  it('ipc closes the remote streams when the window starts a new document', () => {
    const ipc = readFileSync(path.join(__dirname, '../ipc.ts'), 'utf8')
    const nav = ipc.slice(ipc.indexOf("win.webContents.on('did-start-navigation'"))
    expect(nav.slice(0, nav.indexOf('\n  })'))).toContain('remoteStreams?.close()')
  })

  // Performance audit M10: a stream the Runtime gave up, or one whose Runtime could not be found, stayed in the map until
  // its tab detached, and a rebind subscribed it again for nothing. It is forgotten once it is reported gone.
  it('forgets a stream once it is reported gone: a rebind does not subscribe it again', async () => {
    const r = rig()
    await r.streams.attach('rt_1', 's1', 'pty-1')
    r.rt().subs[0].h.onGone!('PTY_NOT_FOUND', 'gone')
    expect(r.rt().subs[0].stopped).toBe(true)
    await r.streams.attach('rt_x', 's2', 'pty-2')
    r.clients.set('rt_x', fakeClient())
    await r.streams.rebind('rt_1')
    await r.streams.rebind('rt_x')
    expect(r.rt().subs).toHaveLength(1)
    expect(r.clients.get('rt_x')!.subs).toHaveLength(0)
  })

})

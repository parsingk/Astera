import { describe, it, expect, vi } from 'vitest'
import { HOST_FEATURE_MCP_HTTP, type McpHttpState } from '../../core/host/protocol'
import type { McpHttpView } from '../../core/types'
import { createHostMcpHttpView } from './hostMcpHttp'

const running: McpHttpState = { state: 'running', url: 'http://127.0.0.1:7871/mcp', lan: false, port: 7871 }
const starting: McpHttpState = { state: 'starting', lan: false, port: 7871 }

const rig = (o: { features?: string[]; connected?: boolean; answer?: (cmd: string) => Promise<{ status: number; body: unknown }> } = {}) => {
  const status = { connected: o.connected ?? true, features: o.features ?? [HOST_FEATURE_MCP_HTTP] }
  const changed: McpHttpView[] = []
  const logs: string[] = []
  const call = vi.fn(async (m: { cmd: string; args: Record<string, unknown>; sessionId: string }) =>
    o.answer ? o.answer(m.cmd) : { status: 200, body: m.cmd === 'mcp-http-reload' ? starting : running }
  )
  const view = createHostMcpHttpView({ status: () => status, call, changed: (v) => changed.push(v), log: (m) => logs.push(m) })
  return { view, changed, logs, call, status }
}

describe('createHostMcpHttpView', () => {
  it('forwards a state pushed by a Host that announced mcp-http', () => {
    const { view, changed } = rig()
    view.pushed({ t: 'mcp-http-state', state: running })
    expect(changed).toEqual([{ host: true, state: running }])
    expect(view.current()).toEqual({ host: true, state: running })
  })

  it('drops a push from a Host without the feature, and a push it cannot read', () => {
    const quiet = rig({ features: [] })
    quiet.view.pushed({ t: 'mcp-http-state', state: running })
    expect(quiet.changed).toEqual([])
    const { view, changed, logs } = rig()
    view.pushed({ t: 'mcp-http-state', state: { state: 'up', lan: false, port: 1 } } as never)
    view.pushed({ t: 'mcp-http-state', state: { state: 'running', lan: 'no', port: 1 } } as never)
    expect(changed).toEqual([])
    expect(logs.filter((l) => l.includes('could not read'))).toHaveLength(2)
  })

  it('keeps only the fields the state may carry', () => {
    const { view } = rig()
    view.pushed({ t: 'mcp-http-state', state: { ...running, error: 7, token: 'x' } } as never)
    expect(view.current()).toEqual({ host: true, state: running })
  })

  it('keeps the URLs other devices can use, and only the entries it can read', () => {
    const { view } = rig()
    const urls = [
      { url: 'http://192.168.1.5:7871/mcp', kind: 'lan' },
      { url: 'http://100.90.1.2:7871/mcp', kind: 'tailscale' },
      { url: 'http://box:7871/mcp', kind: 'name' }
    ]
    view.pushed({ t: 'mcp-http-state', state: { ...running, lan: true, urls: [...urls, { url: 'http://x/mcp', kind: 'other' }, { url: 7, kind: 'lan' }, 'y'] } } as never)
    expect(view.current()).toEqual({ host: true, state: { ...running, lan: true, urls } })
    view.pushed({ t: 'mcp-http-state', state: { ...running, lan: true, urls: 'no' } } as never)
    expect(view.current()).toEqual({ host: true, state: { ...running, lan: true } })
  })

  it('asks for the state after each handshake with a Host that has it', async () => {
    const { view, changed, call } = rig()
    await view.connected()
    expect(call).toHaveBeenCalledWith({ cmd: 'mcp-http-status', args: {}, sessionId: '' })
    expect(changed).toEqual([{ host: true, state: running }])
  })

  it('an older Host is asked nothing and reads as older', async () => {
    const { view, changed, call } = rig({ features: ['workspace'] })
    await view.connected()
    expect(call).not.toHaveBeenCalled()
    expect(changed).toEqual([{ host: false, reason: 'older' }])
    expect(await view.reload()).toEqual({ host: false, reason: 'older' })
    expect(call).not.toHaveBeenCalled()
  })

  it('a dropped connection reads as no Host, told once', () => {
    const { view, changed, status } = rig()
    view.pushed({ t: 'mcp-http-state', state: running })
    status.connected = false
    view.status()
    view.status()
    expect(changed).toEqual([{ host: true, state: running }, { host: false, reason: 'none' }])
    expect(view.current()).toEqual({ host: false, reason: 'none' })
  })

  it('reload sends mcp-http-reload and takes its answer', async () => {
    const { view, call, changed } = rig()
    expect(await view.reload()).toEqual({ host: true, state: starting })
    expect(call).toHaveBeenCalledWith({ cmd: 'mcp-http-reload', args: {}, sessionId: '' })
    expect(changed).toEqual([{ host: true, state: starting }])
  })

  // The reload answers `starting`; `running` arrives as a push. A push that lands while the call is out
  // is newer than its answer, so the answer must not put `starting` back over it.
  it('an answer older than a push that came in meanwhile is not applied', async () => {
    let release: () => void = () => {}
    const { view } = rig({
      answer: () => new Promise((r) => (release = () => r({ status: 200, body: starting })))
    })
    const out = view.reload()
    view.pushed({ t: 'mcp-http-state', state: running })
    release()
    expect(await out).toEqual({ host: true, state: running })
    expect(view.current()).toEqual({ host: true, state: running })
  })

  it('a refused or failed call is logged and never rejects', async () => {
    const refused = rig({ answer: async () => ({ status: 501, body: { error: 'x' } }) })
    expect(await refused.view.reload()).toEqual({ host: true, state: null })
    expect(refused.logs.some((l) => l.includes('mcp-http-reload answered 501'))).toBe(true)
    const thrown = rig({ answer: async () => Promise.reject(new Error('gone')) })
    await thrown.view.connected()
    expect(thrown.logs.some((l) => l.includes('mcp-http-status failed'))).toBe(true)
  })
})

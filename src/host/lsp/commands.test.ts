import { describe, it, expect, vi } from 'vitest'
import { NpmFailed, NpmMissing } from '../plugins/npm'
import type { LspInstalled, LspServerStatus } from '../../core/lsp/model'
import { LspIntegrityFailed, LspUnavailable } from './install'
import { LSP_CHANGES, LSP_COMMANDS, lspCommand } from './commands'

// Phase 3 Part 3: the Host's lsp-* commands, for this machine's app and CLI; an agent's shell may read but not change
const listed: LspInstalled[] = [{ server: 'python', available: true, installed: false, packages: [], folder: '/p/language-servers' }]
const running: LspServerStatus[] = [{ server: 'python', root: '/r', status: 'running', pid: 4 }]

function rig(over: { install?: () => Promise<void> } = {}) {
  const installer = {
    list: vi.fn(async () => listed),
    install: vi.fn(over.install ?? (async () => {})),
    remove: vi.fn(async () => {})
  }
  const order: string[] = []
  const manager = {
    status: vi.fn(() => running),
    refresh: vi.fn(() => {
      order.push('refresh')
    }),
    restart: vi.fn(),
    withServerStopped: vi.fn(async (id: string, fn: () => Promise<void>) => {
      order.push(`stop ${id}`)
      await fn()
      order.push(`start ${id}`)
    }),
    logFile: vi.fn((server: string, root: string) => `/logs/${server}-${root}.log`)
  }
  const call = (cmd: string, args: Record<string, unknown> = {}, extra: { agentRefusal?: string; readLog?: (f: string) => Promise<string> } = {}) =>
    lspCommand({ cmd, args, installer, manager, ...extra })
  return { installer, manager, call, order }
}

describe('lspCommand', () => {
  it('names its commands, and which change what is installed', () => {
    expect([...LSP_COMMANDS]).toEqual(['lsp-status', 'lsp-install', 'lsp-remove', 'lsp-restart', 'lsp-log'])
    expect([...LSP_CHANGES]).toEqual(['lsp-install', 'lsp-remove', 'lsp-restart'])
  })

  it('answers the status: each running server and what is installed', async () => {
    const r = rig()
    expect(await r.call('lsp-status')).toEqual({ status: 200, body: { servers: running, installed: listed } })
  })

  it('installs a server, and refuses a server it does not know', async () => {
    const r = rig()
    expect(await r.call('lsp-install', { server: 'python' })).toEqual({ status: 200, body: { server: 'python', installed: true } })
    expect(r.installer.install).toHaveBeenCalledWith('python')
    // Final review C2: what was refused for want of it starts once it is there
    expect(r.manager.refresh).toHaveBeenCalledTimes(1)
    expect((await r.call('lsp-install', { server: 'rust' })).status).toBe(400)
    expect((await r.call('lsp-install', {})).status).toBe(400)
  })

  it('maps install failures to their statuses', async () => {
    const cases: Array<[Error, number, string]> = [
      [new LspUnavailable('no package for freebsd'), 409, 'LSP_UNAVAILABLE'],
      [new LspIntegrityFailed('sha512 differs'), 422, 'LSP_INTEGRITY'],
      [new NpmFailed('npm could not fetch pyright@1.1.414: E404'), 502, 'PLUGIN_NPM_FAILED'],
      [new NpmMissing(), 502, 'PLUGIN_NPM_MISSING']
    ]
    for (const [e, status, code] of cases) {
      const r = rig({ install: async () => Promise.reject(e) })
      expect(await r.call('lsp-install', { server: 'python' }), code).toEqual({ status, body: { code, error: e.message } })
    }
  })

  // Final review M12: nothing starts the server again while its folder is being removed, and what used it is told after
  it('removes a server while it is kept stopped everywhere, then refreshes', async () => {
    const r = rig()
    r.installer.remove.mockImplementation(async () => {
      r.order.push('remove')
    })
    expect(await r.call('lsp-remove', { server: 'typescript5' })).toEqual({ status: 200, body: { server: 'typescript5', installed: false } })
    expect(r.order).toEqual(['stop typescript5', 'remove', 'start typescript5', 'refresh'])
  })

  // Final review I4: a server that failed or was stopped to make room starts again when the person asks
  it('restarts a server for a root, and refuses one without a root', async () => {
    const r = rig()
    expect(await r.call('lsp-restart', { server: 'python', root: '/r' })).toEqual({ status: 200, body: { server: 'python', root: '/r', restarted: true } })
    expect(r.manager.restart).toHaveBeenCalledWith('python', '/r')
    expect((await r.call('lsp-restart', { server: 'python' })).status).toBe(400)
    expect((await r.call('lsp-restart', { server: 'python', root: '/r' }, { agentRefusal: 'for a person' })).status).toBe(403)
  })

  it('reads the last 200 lines of a server’s log for a root, and none when it has none', async () => {
    const r = rig()
    const text = Array.from({ length: 250 }, (_, i) => `line ${i}`).join('\n') + '\n'
    const got = await r.call('lsp-log', { server: 'python', root: '/r' }, { readLog: async () => text })
    expect(r.manager.logFile).toHaveBeenCalledWith('python', '/r')
    expect((got.body as { lines: string[] }).lines).toHaveLength(200)
    expect((got.body as { lines: string[] }).lines[199]).toBe('line 249')
    expect(await r.call('lsp-log', { server: 'python', root: '/r' }, { readLog: async () => Promise.reject(new Error('ENOENT')) })).toEqual({ status: 200, body: { lines: [] } })
    expect((await r.call('lsp-log', { server: 'python' })).status).toBe(400)
  })

  it('refuses the changes to an agent’s shell, and lets it read', async () => {
    const r = rig()
    const refusal = 'lsp-install is for a person'
    expect(await r.call('lsp-install', { server: 'python' }, { agentRefusal: refusal })).toEqual({ status: 403, body: { error: refusal } })
    expect((await r.call('lsp-remove', { server: 'python' }, { agentRefusal: refusal })).status).toBe(403)
    expect((await r.call('lsp-status', {}, { agentRefusal: refusal })).status).toBe(200)
    expect(r.installer.install).not.toHaveBeenCalled()
  })
})

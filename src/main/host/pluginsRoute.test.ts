import { describe, it, expect } from 'vitest'
import { createPluginsRoute, PLUGIN_CHANGE_DEADLINE_MS } from './pluginsRoute'
import { NO_HOST_CONNECTION, hostDeadlineMessage } from './worktreeRoute'
import { DEFAULT_CHECK_TIMEOUT_MS } from '../../core/orchestration/types'

type Sent = { cmd: string; args: Record<string, unknown>; sessionId: string; timeoutMs?: number }

/** A Host that answers every call with `answer`, and records what it was sent. */
const host = (answer: (m: Sent) => Promise<{ status: number; body: unknown }> = async () => ({ status: 200, body: { ok: 1 } })) => {
  const sent: Sent[] = []
  const route = createPluginsRoute({
    call: (m) => {
      sent.push(m)
      return answer(m)
    }
  })
  return { route, sent }
}

describe('the plugins route (plugin runtime design P5, slice 2d)', () => {
  it('sends each command the tab uses, with its arguments, as the app with no session', async () => {
    const { route, sent } = host()
    await route.list()
    await route.inspect({ path: 'D:/work/jira 플러그인' })
    await route.install({ path: 'D:/work/jira 플러그인', grant: ['jobs.read'], expect: { name: '@acme/jira', version: '1.0.0' } })
    await route.setEnabled('@acme/jira', false)
    await route.setEnabled('@acme/jira', true)
    await route.remove('@acme/jira')
    await route.logs('@acme/jira', 200)
    await route.settings('@acme/jira')
    await route.configure('@acme/jira', { baseUrl: 'https://a.example.com', dryRun: true }, ['token'])
    expect(sent.map(({ cmd, args, sessionId }) => ({ cmd, args, sessionId }))).toEqual([
      { cmd: 'plugins-list', args: {}, sessionId: '' },
      { cmd: 'plugins-inspect', args: { path: 'D:/work/jira 플러그인' }, sessionId: '' },
      {
        cmd: 'plugins-install',
        args: { path: 'D:/work/jira 플러그인', grant: ['jobs.read'], expect: { name: '@acme/jira', version: '1.0.0' } },
        sessionId: ''
      },
      { cmd: 'plugins-disable', args: { id: '@acme/jira' }, sessionId: '' },
      { cmd: 'plugins-enable', args: { id: '@acme/jira' }, sessionId: '' },
      { cmd: 'plugins-remove', args: { id: '@acme/jira' }, sessionId: '' },
      { cmd: 'plugins-logs', args: { id: '@acme/jira', lines: 200 }, sessionId: '' },
      { cmd: 'plugins-settings', args: { id: '@acme/jira' }, sessionId: '' },
      { cmd: 'plugins-configure', args: { id: '@acme/jira', set: { baseUrl: 'https://a.example.com', dryRun: true }, unset: ['token'] }, sessionId: '' }
    ])
  })

  // 2d final review M8: only the commands the tab uses (design P5), nothing a renderer could reach beyond them.
  it('offers exactly the commands Settings › Plugins uses', () => {
    expect(Object.keys(host().route).sort()).toEqual(['audit', 'configure', 'doctor', 'get', 'inspect', 'install', 'list', 'logs', 'remove', 'setEnabled', 'settings'])
  })

  // Phase 2 remaining: the Plugin Inspector reads one plugin, its checks and its recent records, as reads
  it('sends the Inspector’s reads as the Host’s get, doctor and audit, with no change deadline', async () => {
    const { route, sent } = host()
    await route.get('hello-panel')
    await route.doctor('hello-panel')
    await route.audit('hello-panel', 50)
    expect(sent.map((m) => [m.cmd, m.args, m.timeoutMs])).toEqual([
      ['plugins-get', { id: 'hello-panel' }, undefined],
      ['plugins-doctor', { id: 'hello-panel' }, undefined],
      ['plugins-audit', { id: 'hello-panel', lines: 50 }, undefined]
    ])
  })

  // Plugins 2e: a package on npm is a source beside a folder, and its inspect downloads, so it waits as a change does.
  it('inspects and installs an npm package, waiting for the download', async () => {
    const { route, sent } = host()
    await route.inspect({ npm: '@acme/jira@^1.0.0' })
    await route.install({ npm: '@acme/jira@^1.0.0', grant: [], expect: { name: '@acme/jira', version: '1.0.0' } })
    await route.inspect({ path: 'D:/p' })
    expect(sent.map(({ cmd, args, timeoutMs }) => ({ cmd, args, timeoutMs }))).toEqual([
      { cmd: 'plugins-inspect', args: { npm: '@acme/jira@^1.0.0' }, timeoutMs: PLUGIN_CHANGE_DEADLINE_MS },
      { cmd: 'plugins-install', args: { npm: '@acme/jira@^1.0.0', grant: [], expect: { name: '@acme/jira', version: '1.0.0' } }, timeoutMs: PLUGIN_CHANGE_DEADLINE_MS },
      { cmd: 'plugins-inspect', args: { path: 'D:/p' }, timeoutMs: undefined }
    ])
  })

  it('waits as long as the CLI does for a change, and the usual deadline for a read', async () => {
    const { route, sent } = host()
    await route.list()
    await route.install({ path: 'p', grant: [], expect: { name: 'x', version: '1.0.0' } })
    await route.configure('x', {}, [])
    await route.remove('x')
    await route.setEnabled('x', true)
    await route.logs('x', 10)
    expect(sent.map((m) => [m.cmd, m.timeoutMs])).toEqual([
      ['plugins-list', undefined],
      ['plugins-install', PLUGIN_CHANGE_DEADLINE_MS],
      ['plugins-configure', PLUGIN_CHANGE_DEADLINE_MS],
      ['plugins-remove', PLUGIN_CHANGE_DEADLINE_MS],
      ['plugins-enable', PLUGIN_CHANGE_DEADLINE_MS],
      ['plugins-logs', undefined]
    ])
    expect(PLUGIN_CHANGE_DEADLINE_MS).toBeGreaterThan(DEFAULT_CHECK_TIMEOUT_MS)
  })

  it('answers the Host body on 200, and its sentence with a code otherwise', async () => {
    const answers: Record<number, unknown> = { 200: { plugins: [] }, 400: { error: 'bad' }, 403: { error: 'no' }, 404: { error: 'none' }, 409: { error: 'changed since shown' }, 500: { error: 'disk' } }
    let status = 200
    const { route } = host(async () => ({ status, body: answers[status] }))
    expect(await route.list()).toEqual({ ok: true, body: { plugins: [] } })
    const codes: Array<[number, string]> = [
      [400, 'INVALID_ARGUMENTS'],
      [403, 'FORBIDDEN'],
      [404, 'NOT_FOUND'],
      [409, 'CONFLICT'],
      [500, 'FAILED']
    ]
    for (const [s, code] of codes) {
      status = s
      expect(await route.list(), String(s)).toEqual({ ok: false, code, message: (answers[s] as { error: string }).error })
    }
  })

  // 2e-2 final review M1: the reason the Host gives on its own reaches the app.
  it('carries the reason the Host gives beside its sentence', async () => {
    const { route } = host(async () => ({ status: 500, body: { error: 'npm is not installed, and ...', code: 'PLUGIN_NPM_BLOCKED', reason: 'answered 407' } }))
    expect(await route.list()).toEqual({ ok: false, code: 'PLUGIN_NPM_BLOCKED', message: 'npm is not installed, and ...', reason: 'answered 407' })
  })

  it('says a Host older than plugins, or one that runs none, does not support them', async () => {
    for (const error of ['unknown command: plugins-list', 'this Host does not run plugins']) {
      const { route } = host(async () => ({ status: 501, body: { error } }))
      expect(await route.list()).toEqual({ ok: false, code: 'NOT_SUPPORTED', message: error })
    }
  })

  it('tells no Host from a Host that did not answer in time, and from one that went away', async () => {
    const failing = (message: string) => host(async () => Promise.reject(new Error(message))).route
    expect(await failing(NO_HOST_CONNECTION).list()).toEqual({ ok: false, code: 'HOST_NOT_RUNNING', message: NO_HOST_CONNECTION })
    const late = hostDeadlineMessage('plugins-install', PLUGIN_CHANGE_DEADLINE_MS)
    expect(await failing(late).install({ path: 'p', grant: [], expect: { name: 'x', version: '1' } })).toEqual({ ok: false, code: 'TIMEOUT', message: late })
    expect(await failing('the Host connection closed').list()).toEqual({ ok: false, code: 'HOST_LOST', message: 'the Host connection closed' })
  })

  it('answers a body that is not an object as an empty one, and a refusal without a sentence with its status', async () => {
    let body: unknown = null
    let status = 200
    const { route } = host(async () => ({ status, body }))
    expect(await route.list()).toEqual({ ok: true, body: {} })
    status = 500
    body = 'x'
    expect(await route.list()).toEqual({ ok: false, code: 'FAILED', message: 'the Host answered 500' })
  })
})

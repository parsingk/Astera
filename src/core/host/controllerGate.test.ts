import { describe, it, expect } from 'vitest'
import { controllerRefusal, CONTROLLER_READ_COMMANDS, CONTROLLER_CONTROL_COMMANDS } from './controllerGate'

const p = (permission: string) => ({ clientId: 'cli_ab12', name: 'laptop', permission }) as never

describe('controllerRefusal (remote runtime design §3.4)', () => {
  it('lets every read through at both levels', () => {
    for (const cmd of CONTROLLER_READ_COMMANDS) {
      expect(controllerRefusal(cmd, p('read-only'))).toBeNull()
      expect(controllerRefusal(cmd, p('full-control'))).toBeNull()
    }
  })
  it('lets control through only at full-control', () => {
    for (const cmd of CONTROLLER_CONTROL_COMMANDS) {
      expect(controllerRefusal(cmd, p('full-control'))).toBeNull()
      expect(controllerRefusal(cmd, p('read-only'))).toMatchObject({ status: 403, body: { code: 'RUNTIME_PERMISSION_DENIED' } })
    }
  })
  // GitHub lifecycle §6.4 (G5c): a controller carries a Runtime's Run through GitHub again with control; the raw writes stay off
  it('lets runs-reconverge through at full-control only', () => {
    expect(controllerRefusal('runs-reconverge', p('full-control'))).toBeNull()
    expect(controllerRefusal('runs-reconverge', p('read-only'))).toMatchObject({ status: 403, body: { code: 'RUNTIME_PERMISSION_DENIED' } })
  })
  it('refuses what a controller never reaches, at any level', () => {
    for (const cmd of ['state-put', 'reset', 'worktree-add', 'pair-create', 'clients-list', 'clients-revoke', 'projects-add', 'github-pr-create', 'understanding-list', 'app-js', 'slack-reload', 'journal-append', 'sources-list', 'sources-items', 'sources-show', 'jobs-create-from-source', 'a-command-added-later'])
      expect(controllerRefusal(cmd, p('full-control'))).toMatchObject({ status: 403, body: { code: 'RUNTIME_PERMISSION_DENIED' } })
  })
  // Plugin runtime design P5: a remote controller never manages this machine's plugins.
  it('refuses every plugins command at full control', () => {
    for (const cmd of ['plugins-inspect', 'plugins-install', 'plugins-list', 'plugins-get', 'plugins-enable', 'plugins-disable', 'plugins-remove'])
      expect(controllerRefusal(cmd, p('full-control'))).toMatchObject({ status: 403, body: { code: 'RUNTIME_PERMISSION_DENIED' } })
  })
  it('denies an unknown level, and a call with no principal at all', () => {
    expect(controllerRefusal('jobs-list', p('control'))).toMatchObject({ status: 403 })
    expect(controllerRefusal('jobs-list', undefined)).toMatchObject({ status: 401, body: { code: 'RUNTIME_AUTH_FAILED' } })
  })

  // Phase 4 ruling: the two waits are long-poll reads (§3.1 budgets them as in-flight calls).
  // G7a: a paired Runtime's New Job window asks that Runtime whether its folder can carry the lifecycle
  it('lets github-preflight through as a read', () => {
    expect(CONTROLLER_READ_COMMANDS).toContain('github-preflight')
    expect(controllerRefusal('github-preflight', p('read-only'))).toBeNull()
  })

  it('lets runs-wait and jobs-wait through as reads', () => {
    for (const cmd of ['runs-wait', 'jobs-wait'])
      expect(controllerRefusal(cmd, { clientId: 'c', name: 'n', permission: 'read-only' } as never), cmd).toBeNull()
  })
})

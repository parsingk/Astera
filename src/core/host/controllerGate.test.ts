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
  it('refuses what a controller never reaches, at any level', () => {
    for (const cmd of ['state-put', 'reset', 'worktree-add', 'pair-create', 'clients-list', 'clients-revoke', 'projects-add', 'github-pr-create', 'understanding-list', 'app-js', 'slack-reload', 'journal-append', 'a-command-added-later'])
      expect(controllerRefusal(cmd, p('full-control'))).toMatchObject({ status: 403, body: { code: 'RUNTIME_PERMISSION_DENIED' } })
  })
  it('denies an unknown level, and a call with no principal at all', () => {
    expect(controllerRefusal('jobs-list', p('control'))).toMatchObject({ status: 403 })
    expect(controllerRefusal('jobs-list', undefined)).toMatchObject({ status: 401, body: { code: 'RUNTIME_AUTH_FAILED' } })
  })
})

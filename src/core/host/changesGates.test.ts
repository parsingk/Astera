// Phase 10: a Run's changed files and diffs are reads (spec §2 table: CLI yes, read-only and full control allowed), for
// a remote controller, an MCP client and the app's remote client alike; and a Runtime says it serves them.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { controllerRefusal } from './controllerGate'
import { mcpRefusal } from './mcpGate'
import { remoteTarget, remoteMutation } from '../remote/targets'

const principal = (permission: 'read-only' | 'full-control') => ({ clientId: 'c', name: 'laptop', permission }) as never

describe('changed files and diff gates', () => {
  for (const cmd of ['runs-changed-files', 'runs-diff']) {
    it(`${cmd} is a read for a controller of either permission and for MCP`, () => {
      expect(controllerRefusal(cmd, principal('read-only'))).toBeNull()
      expect(controllerRefusal(cmd, principal('full-control'))).toBeNull()
      expect(mcpRefusal(cmd, 'read' as never, false, false)).toBeNull()
      expect(remoteTarget(cmd)).not.toBe('no')
      expect(remoteMutation(cmd)).toBe(false)
    })
  }
  it('runs-git-record is never a controller’s or an MCP client’s', () => {
    expect(controllerRefusal('runs-git-record', principal('full-control'))).not.toBeNull()
    expect(mcpRefusal('runs-git-record', 'write' as never, true, true)).not.toBeNull()
  })
  it('the Runtime’s hello names both', () => {
    const index = readFileSync(path.join(__dirname, '../../host/index.ts'), 'utf8')
    expect(index).toMatch(/capabilities: \[[^\]]*'remote\.changed-files'[^\]]*'remote\.diff'/)
  })
})

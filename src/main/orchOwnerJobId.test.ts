// Phase 10 review I3: the app's ownership check on `orch.command` reads a Job id as that Job's latest Run, as the
// commands themselves do (resolveRunId), so another project's Job id is not a way past it. The check lives inside
// registerIpc, so its text is guarded here.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

describe('orchOwnerMismatch', () => {
  it('resolves a Job id to its Run before judging who owns it', () => {
    const ipc = readFileSync(path.join(__dirname, 'ipc.ts'), 'utf8')
    const at = ipc.indexOf('const orchOwnerMismatch = (')
    const body = ipc.slice(at, ipc.indexOf('const taskKeys', at))
    expect(body).toMatch(/resolveRunId\(state, /)
  })
})

// Phase 10 review I3: the app's ownership check on `orch.command` reads a Job id as that Job's latest Run, as the
// commands themselves do (resolveRunId), so another project's Job id is not a way past it. Since G7a the check is core's
// ownerMismatchOf (orchestration/ownerCheck.ts, where the Job id case is tested); registerIpc's wrapper is guarded here
// to hand every command to it.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

describe('orchOwnerMismatch', () => {
  it('hands every command to the tested check, with the ids of the project the window shows', () => {
    const ipc = readFileSync(path.join(__dirname, 'ipc.ts'), 'utf8')
    const at = ipc.indexOf('const orchOwnerMismatch = (')
    const body = ipc.slice(at, at + 400)
    expect(body).toMatch(/ownerMismatchOf\(state, project, idsOfProject\(state, project, /)
  })
})

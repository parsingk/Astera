import { describe, it, expect } from 'vitest'
import type { AuditRecord } from '../audit/types'
import { auditWriteTargets } from './auditWrites'

// Phase 3 Part 4: the observe audit's write records corroborate an attempt's range ("confirmed by observe audit")
const record = (target: string, over: Partial<AuditRecord> = {}): AuditRecord => ({ target, insideProject: true, ...over }) as AuditRecord

describe('auditWriteTargets', () => {
  it('asks for the Task’s file writes in the window, and answers the paths they named', async () => {
    const asked: unknown[] = []
    const got = await auditWriteTargets('PROF', { taskId: 't1', since: 'S', until: 'U' }, async (dir, f) => {
      asked.push([dir, f])
      return [record('src/a.ts'), record('src/b.ts (+2)'), record('outside project: x', { insideProject: false })]
    })
    expect(asked).toEqual([['PROF', { taskId: 't1', action: 'filesystem.write', since: 'S', until: 'U', limit: 2000 }]])
    expect([...(got ?? [])]).toEqual(['src/a.ts', 'src/b.ts'])
  })

  it('answers null with no records, as observe was off', async () => {
    expect(await auditWriteTargets('PROF', { taskId: 't1', since: 'S', until: 'U' }, async () => [])).toBeNull()
  })

  it('answers null when the records cannot be read', async () => {
    expect(await auditWriteTargets('PROF', { taskId: 't1', since: 'S', until: 'U' }, async () => Promise.reject(new Error('EACCES')))).toBeNull()
  })
})

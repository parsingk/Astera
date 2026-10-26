// Credential-use records (credentials design §6): their own day files beside the tool calls, the same retention, read
// back newest first with the filters the Audit Logs view and `credentials-uses` need.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendCredentialUses, newUseId, queryCredentialUses } from './uses'
import type { CredentialUse } from '../audit/types'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-uses-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const NOW = Date.parse('2026-10-26T12:00:00.000Z')
const use = (id: string, at: string, over: Partial<CredentialUse> = {}): CredentialUse => ({
  id,
  at,
  actor: 'session',
  sessionId: 's1',
  entryId: 'mcp:m1',
  provider: 'mcp',
  action: 'mcp.call',
  resource: 'linear/create_issue',
  outcome: 'ok',
  evidence: 'managed',
  requestId: `rq_${id}`,
  ...over
})
const opts = { now: () => NOW }

describe('credential-use records', () => {
  it('appends and reads back newest first', async () => {
    await appendCredentialUses(dir, [use('cu_a', '2026-10-26T10:00:00.000Z'), use('cu_b', '2026-10-26T11:00:00.000Z')], opts)
    await appendCredentialUses(dir, [use('cu_c', '2026-10-25T09:00:00.000Z')], opts)
    expect((await queryCredentialUses(dir, {}, opts)).map((u) => u.id)).toEqual(['cu_b', 'cu_a', 'cu_c'])
    expect(await fs.readdir(path.join(dir, 'credential-uses'))).toEqual(expect.arrayContaining(['2026-10-25.jsonl', '2026-10-26.jsonl']))
  })

  it('filters by entry, provider and session', async () => {
    await appendCredentialUses(
      dir,
      [
        use('cu_a', '2026-10-26T10:00:00.000Z'),
        use('cu_b', '2026-10-26T10:01:00.000Z', { sessionId: 's2' }),
        use('cu_c', '2026-10-26T10:02:00.000Z', { entryId: undefined, provider: 'github', action: 'github.pr.create', resource: 'o/r', evidence: 'observed' })
      ],
      opts
    )
    expect((await queryCredentialUses(dir, { entryId: 'mcp:m1' }, opts)).map((u) => u.id)).toEqual(['cu_b', 'cu_a'])
    expect((await queryCredentialUses(dir, { provider: 'github' }, opts)).map((u) => u.id)).toEqual(['cu_c'])
    expect((await queryCredentialUses(dir, { sessionId: 's2' }, opts)).map((u) => u.id)).toEqual(['cu_b'])
  })

  it('pages with until and beforeId like audit-list', async () => {
    const at = '2026-10-26T10:00:00.000Z'
    await appendCredentialUses(dir, [use('cu_a', at), use('cu_b', at), use('cu_c', '2026-10-26T09:00:00.000Z')], opts)
    const first = await queryCredentialUses(dir, { limit: 1 }, opts)
    expect(first.map((u) => u.id)).toEqual(['cu_b'])
    const next = await queryCredentialUses(dir, { until: at, beforeId: 'cu_b', limit: 5 }, opts)
    expect(next.map((u) => u.id)).toEqual(['cu_a', 'cu_c'])
  })

  it('prunes past 30 days', async () => {
    await appendCredentialUses(dir, [use('cu_old', '2026-09-01T10:00:00.000Z')], { now: () => Date.parse('2026-09-01T12:00:00.000Z') })
    await appendCredentialUses(dir, [use('cu_new', '2026-10-26T10:00:00.000Z')], { now: () => NOW + 2 * 60 * 60 * 1000 })
    expect((await queryCredentialUses(dir, {}, opts)).map((u) => u.id)).toEqual(['cu_new'])
    expect(await fs.readdir(path.join(dir, 'credential-uses'))).not.toContain('2026-09-01.jsonl')
  })

  it('skips a line that is not a credential use', async () => {
    await fs.mkdir(path.join(dir, 'credential-uses'), { recursive: true })
    await fs.writeFile(path.join(dir, 'credential-uses', '2026-10-26.jsonl'), '{"id":"x"}\nnot json\n')
    await appendCredentialUses(dir, [use('cu_a', '2026-10-26T10:00:00.000Z')], opts)
    expect((await queryCredentialUses(dir, {}, opts)).map((u) => u.id)).toEqual(['cu_a'])
  })

  it('makes use ids that differ', () => {
    expect(newUseId()).toMatch(/^cu_[0-9a-f]{16}$/)
    expect(newUseId()).not.toBe(newUseId())
  })
})

import { describe, it, expect } from 'vitest'
import { deleteRun, pauseRun, restartCoordinator, resumeRun, type ActionUi } from './jobActions'
import type { OrchDoor } from './orchDoor'
import type { OrchSnapshot } from '../../../core/types'

/** A door that records each command and answers from `reply`. */
const door = (reply: { status: number; body: unknown } = { status: 200, body: {} }) => {
  const sent: Array<[string, Record<string, unknown>]> = []
  const d: OrchDoor = {
    projectKey: '/repo',
    readOnlyReason: null,
    command: async (cmd, args) => (sent.push([cmd, args]), reply),
    accounts: async () => [],
    signedInIds: async () => new Set(),
    runConfigs: async () => []
  }
  return Object.assign(d, { sent })
}

/** A ui whose dialogs answer as told and that records what it was asked and what it showed. */
const ui = (o: { confirm?: boolean; checked?: string[] | null; hide?: boolean } = {}) => {
  const asked: Array<{ title: string; body: string; choices?: Array<{ id: string }> }> = []
  const errors: string[] = []
  const hidden: string[] = []
  const u: ActionUi = {
    t: (key, params) => `${key}${params ? ` ${JSON.stringify(params)}` : ''}`,
    confirm: async (q) => (asked.push(q), o.confirm ?? true),
    confirmChoices: async (q) => (asked.push(q), o.checked === null ? { ok: false, checked: [] } : { ok: true, checked: o.checked ?? [] }),
    error: (m) => void errors.push(m),
    ...(o.hide ? { hide: (ps: string[]) => void hidden.push(...ps) } : {})
  }
  return Object.assign(u, { asked, errors, hidden })
}

const snapshot = (): OrchSnapshot =>
  ({
    runs: [
      { id: 'r1', objective: 'ship it', total: 2, eventCount: 7, worktrees: ['/wt/a', '/wt/b'], tasks: [{ id: 't1', startedAt: 'x' }, { id: 't2' }] }
    ],
    projectFolderBusy: false
  }) as unknown as OrchSnapshot

describe('Job actions through a door (remote runtime design Phase 7)', () => {
  it('delete asks with the counts and the worktree choices, then sends merge and removal as chosen', async () => {
    const d = door()
    const u = ui({ checked: ['merge', 'worktrees'], hide: true })
    await deleteRun(d, snapshot(), 'r1', u)
    expect(u.asked[0].body).toContain('"objective":"ship it"')
    expect(u.asked[0].choices?.map((c) => c.id)).toEqual(['merge', 'hide', 'worktrees'])
    expect(d.sent).toEqual([['run-delete', { id: 'r1', merge: true, removeWorktrees: true }]])
  })
  it('hide hides the folders only after the delete went through', async () => {
    const u = ui({ checked: ['hide'], hide: true })
    await deleteRun(door(), snapshot(), 'r1', u)
    expect(u.hidden).toEqual(['/wt/a', '/wt/b'])
    const refused = ui({ checked: ['hide'], hide: true })
    await deleteRun(door({ status: 409, body: { error: 'running' } }), snapshot(), 'r1', refused)
    expect(refused.hidden).toEqual([])
  })
  it('a delete with no hide (a remote Job: the history list is this computer\'s) offers no "hide" choice', async () => {
    const u = ui({ checked: [] })
    await deleteRun(door(), snapshot(), 'r1', u)
    expect(u.asked[0].choices?.map((c) => c.id)).toEqual(['merge', 'worktrees'])
  })
  it('a declined delete sends nothing', async () => {
    const d = door()
    await deleteRun(d, snapshot(), 'r1', ui({ checked: null }))
    expect(d.sent).toEqual([])
  })
  it('a 409 for a retained worker says so; another 409 says stop first; worktrees kept are said', async () => {
    const retained = ui()
    await deleteRun(door({ status: 409, body: { error: 'worker-retain holds it' } }), snapshot(), 'r1', retained)
    expect(retained.errors).toEqual(['jobs.run.deleteRetained'])
    const busy = ui()
    await deleteRun(door({ status: 409, body: { error: 'running' } }), snapshot(), 'r1', busy)
    expect(busy.errors).toEqual(['jobs.run.deleteBusy'])
    const kept = ui()
    await deleteRun(door({ status: 200, body: { worktreesKept: ['/wt/a'] } }), snapshot(), 'r1', kept)
    expect(kept.errors).toEqual(['jobs.run.deleteKeptWorktrees {"count":1}'])
  })
  it('pause asks first and sends run-pause; resume sends run-resume; restart sends run-start', async () => {
    const d = door()
    const declined = ui({ confirm: false })
    await pauseRun(d, 'r1', declined)
    expect(d.sent).toEqual([])
    await pauseRun(d, 'r1', ui())
    await resumeRun(d, 'r1', ui())
    await restartCoordinator(d, 'r1', ui())
    expect(d.sent).toEqual([
      ['run-pause', { run: 'r1' }],
      ['run-resume', { run: 'r1' }],
      ['run-start', { run: 'r1' }]
    ])
  })
  it("a read-only door's refusal is shown with its reason, not as a generic failure", async () => {
    const d = door({ status: 403, body: { error: 'read only pairing', code: 'RUNTIME_PERMISSION_DENIED' } })
    const u = ui()
    await resumeRun(d, 'r1', u)
    await restartCoordinator(d, 'r1', u)
    expect(u.errors).toEqual(['read only pairing', 'read only pairing'])
  })
  it('a Runtime that cannot be asked is a failure, never a success', async () => {
    const u = ui()
    await resumeRun(door({ status: 503, body: { error: 'down', code: 'RUNTIME_OFFLINE' } }), 'r1', u)
    expect(u.errors).toEqual(['jobs.run.pauseFailed'])
  })
})

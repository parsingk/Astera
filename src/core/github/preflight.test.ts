// The checks before a Job may carry the GitHub lifecycle (design 2026-10-17 §7.2): a GitHub origin, a working gh, and
// a permission that can push and rerun CI.
import { describe, it, expect } from 'vitest'
import type { GhResult, GhRunner } from './gh'
import { lifecyclePreflight } from './preflight'

const VIEW = ['repo', 'view', 'o/r', '--json', 'nameWithOwner,viewerPermission']

function gh(answer: Partial<GhResult>, calls: string[][] = []): GhRunner {
  return async (args) => {
    calls.push(args)
    return { ok: true, stdout: '', stderr: '', ...answer }
  }
}
const viewing = (viewerPermission: string): Partial<GhResult> => ({ stdout: JSON.stringify({ nameWithOwner: 'o/r', viewerPermission }) })

describe('lifecyclePreflight', () => {
  it('passes with WRITE on a GitHub origin and names the repository', async () => {
    const calls: string[][] = []
    const r = await lifecyclePreflight({ gh: gh(viewing('WRITE'), calls), originOf: async () => 'git@github.com:o/r.git' }, 'D:/repo')
    expect(r).toEqual({ ok: true, repo: { host: 'github.com', owner: 'o', name: 'r' } })
    expect(calls).toEqual([VIEW])
  })

  it.each(['MAINTAIN', 'ADMIN'])('passes with %s', async (p) => {
    const r = await lifecyclePreflight({ gh: gh(viewing(p)), originOf: async () => 'https://github.com/o/r.git' }, 'D:/repo')
    expect(r.ok).toBe(true)
  })

  it.each(['READ', 'TRIAGE'])('refuses %s and names it', async (p) => {
    const r = await lifecyclePreflight({ gh: gh(viewing(p)), originOf: async () => 'https://github.com/o/r.git' }, 'D:/repo')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.reason).toContain(p)
  })

  it('refuses a folder with no origin, without asking gh', async () => {
    const calls: string[][] = []
    const r = await lifecyclePreflight({ gh: gh({}, calls), originOf: async () => null }, 'D:/repo')
    expect(r).toEqual({ ok: false, reason: 'this folder has no git remote named origin' })
    expect(calls).toEqual([])
  })

  // Review Focus 5: an origin can carry a token; it must never be repeated anywhere
  it('never repeats an origin URL', async () => {
    const r = await lifecyclePreflight({ gh: gh({}), originOf: async () => 'https://user:tok_123456@gitlab.example/o/r/x.git' }, 'D:/repo')
    expect(r).toEqual({ ok: false, reason: 'origin is not a GitHub repository' })
    expect(JSON.stringify(r)).not.toContain('tok_123456')
  })

  it("passes gh's own failure on in one sentence", async () => {
    const r = await lifecyclePreflight(
      { gh: gh({ ok: false, stderr: 'HTTP 401: Bad credentials', exitCode: 1 }), originOf: async () => 'https://github.com/o/r' },
      'D:/repo'
    )
    expect(r).toEqual({ ok: false, reason: 'gh is not logged in: run `gh auth login`' })
  })

  // Final review M9: gh's words alone can send a person to `gh auth login` for a host that is not GitHub at all
  it('names the host when gh fails for an origin that is not on github.com', async () => {
    const r = await lifecyclePreflight(
      { gh: gh({ ok: false, stderr: 'none of the git remotes point to a known GitHub host', exitCode: 1 }), originOf: async () => 'git@gitlab.com:o/r.git' },
      'D:/repo'
    )
    expect(r.ok === false && r.reason).toContain('gitlab.com')
  })

  it('refuses an answer without a permission', async () => {
    const r = await lifecyclePreflight({ gh: gh({ stdout: 'null' }), originOf: async () => 'https://github.com/o/r' }, 'D:/repo')
    expect(r).toEqual({ ok: false, reason: 'gh repo view answered without a permission' })
  })
})

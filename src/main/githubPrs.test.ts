import { describe, it, expect } from 'vitest'
import { createGithubPrs, type GithubPrsDeps } from './githubPrs'
import type { GhResult } from '../core/github/gh'
import { BREAKER_HOLD_MS, MIN_SPACING_MS } from '../core/github/pacing'
import type { WorktreeInfo } from '../core/types'

const wt = (repoPath: string, branch: string): WorktreeInfo => ({
  id: branch,
  repoPath,
  path: `${repoPath}-wt-${branch}`,
  name: branch,
  branch,
  baseRef: 'origin/main',
  createdAt: '2026-09-01T00:00:00.000Z'
})

const openPr = JSON.stringify([
  {
    number: 12,
    title: 'a fix',
    state: 'OPEN',
    isDraft: false,
    url: 'https://github.com/o/r/pull/12',
    headRefName: 'me/fix',
    statusCheckRollup: []
  }
])

function harness(over: Partial<GithubPrsDeps> = {}) {
  let now = 1_000_000
  const sent: Array<{ channel: string; payload: unknown }> = []
  const fetches: string[] = []
  const deps: GithubPrsDeps = {
    registry: { list: () => [wt('C:/repo', 'me/fix')] },
    settings: { getGithubPolling: () => true },
    send: (channel, payload) => sent.push({ channel, payload }),
    probe: async () => ({ kind: 'connected', account: 'me' }),
    fetchPrList: async (repoPath): Promise<GhResult> => {
      fetches.push(repoPath)
      return { ok: true, stdout: openPr, stderr: '' }
    },
    now: () => now,
    ...over
  }
  return { deps, sent, fetches, advance: (ms: number) => (now += ms) }
}

describe('createGithubPrs', () => {
  it('start probes and announces status, without fetching', async () => {
    const h = harness()
    const g = createGithubPrs(h.deps)
    await g.start()
    expect(g.status()).toEqual({ kind: 'connected', account: 'me' })
    expect(h.sent).toEqual([{ channel: 'github:status', payload: { kind: 'connected', account: 'me' } }])
    expect(h.fetches).toEqual([])
  })

  it('a subscribed tick fetches, caches, and pushes the snapshot', async () => {
    const h = harness()
    const g = createGithubPrs(h.deps)
    await g.start()
    g.subscribe()
    await g.tick()
    expect(h.fetches).toEqual(['C:/repo'])
    const snap = g.prs()['C:/repo']
    expect(snap.stale).toBe(false)
    expect(snap.byBranch['me/fix'].number).toBe(12)
    const update = h.sent.find((s) => s.channel === 'github:prs-updated')
    expect(update?.payload).toEqual({ repoRoot: 'C:/repo', snapshot: snap })
    g.stop()
  })

  it('no subscribers means a tick fetches nothing', async () => {
    const h = harness()
    const g = createGithubPrs(h.deps)
    await g.start()
    await g.tick()
    expect(h.fetches).toEqual([])
  })

  it('polling off blocks the tick but not a forced refresh', async () => {
    const h = harness({ settings: { getGithubPolling: () => false } })
    const g = createGithubPrs(h.deps)
    await g.start()
    g.subscribe()
    await g.tick()
    expect(h.fetches).toEqual([])
    await g.refresh({ force: true })
    expect(h.fetches).toEqual(['C:/repo'])
    g.stop()
  })

  it('a rate-limit failure trips the breaker and marks snapshots stale', async () => {
    const h = harness()
    let fail = false
    h.deps.fetchPrList = async (repoPath): Promise<GhResult> => {
      h.fetches.push(repoPath)
      return fail
        ? { ok: false, stdout: '', stderr: 'HTTP 403: API rate limit exceeded for user ID 1' }
        : { ok: true, stdout: openPr, stderr: '' }
    }
    const g = createGithubPrs(h.deps)
    await g.start()
    g.subscribe()
    await g.tick() // healthy fetch fills the cache
    fail = true
    h.advance(MIN_SPACING_MS + 60_000)
    await g.tick() // this one trips the breaker
    expect(g.prs()['C:/repo'].stale).toBe(true)
    const staleEvent = h.sent.filter((s) => s.channel === 'github:prs-updated').at(-1)
    expect((staleEvent?.payload as { snapshot: { stale: boolean } }).snapshot.stale).toBe(true)
    fail = false
    h.advance(BREAKER_HOLD_MS - 1)
    await g.tick()
    expect(h.fetches).toHaveLength(2) // still held
    h.advance(MIN_SPACING_MS + 60_000)
    await g.tick()
    expect(h.fetches).toHaveLength(3) // released, and the fresh fetch clears stale
    expect(g.prs()['C:/repo'].stale).toBe(false)
    g.stop()
  })

  it('an auth failure flips status and stops fetching', async () => {
    const h = harness({
      fetchPrList: async (repoPath): Promise<GhResult> => {
        h.fetches.push(repoPath)
        return { ok: false, stdout: '', stderr: 'HTTP 401: Bad credentials' }
      }
    })
    const g = createGithubPrs(h.deps)
    await g.start()
    g.subscribe()
    await g.tick()
    expect(g.status().kind).toBe('not-authenticated')
    expect(h.sent.filter((s) => s.channel === 'github:status')).toHaveLength(2)
    h.advance(MIN_SPACING_MS + 60_000)
    await g.tick()
    expect(h.fetches).toHaveLength(1) // disconnected — no more calls
    g.stop()
  })

  it('an auth failure empties prs() while keeping the cache for recovery (finding 2)', async () => {
    const h = harness()
    let authFail = false
    h.deps.fetchPrList = async (repoPath): Promise<GhResult> => {
      h.fetches.push(repoPath)
      return authFail
        ? { ok: false, stdout: '', stderr: 'HTTP 401: Bad credentials' }
        : { ok: true, stdout: openPr, stderr: '' }
    }
    const g = createGithubPrs(h.deps)
    await g.start()
    g.subscribe()
    await g.tick() // healthy fetch fills the cache
    expect(g.prs()['C:/repo'].byBranch['me/fix'].number).toBe(12)

    authFail = true
    h.advance(MIN_SPACING_MS + 60_000)
    await g.tick() // the 401
    expect(g.status().kind).toBe('not-authenticated')
    // Gated, not just stale: the collapse/expand round trip in WorktreePanel must not bring the
    // old snapshot straight back with no indication anything changed.
    expect(g.prs()).toEqual({})

    // Recovery: the user re-authenticated elsewhere; a recheck (Re-check, or the settings tab
    // opening — finding 3) finds it, and the next successful fetch repopulates from the cache.
    const probed = await g.recheck()
    expect(probed.kind).toBe('connected')
    authFail = false
    h.advance(MIN_SPACING_MS + 60_000)
    await g.tick()
    expect(g.prs()['C:/repo'].byBranch['me/fix'].number).toBe(12)
    g.stop()
  })

  it('ENOENT from a PR fetch re-probes instead of trusting the raw code (finding 4)', async () => {
    // A worktree's repo folder being deleted raises the exact same ENOENT as gh itself being
    // missing. Trusting the raw code would misreport this repo as "gh not installed"; the probe
    // (run without this repo's broken cwd) is what actually knows gh is fine.
    const h = harness({
      fetchPrList: async (repoPath): Promise<GhResult> => {
        h.fetches.push(repoPath)
        return { ok: false, stdout: '', stderr: '', spawnError: 'ENOENT' }
      }
    })
    const g = createGithubPrs(h.deps)
    await g.start()
    g.subscribe()
    await g.tick()
    expect(g.status()).toEqual({ kind: 'connected', account: 'me' }) // not dragged down to not-installed
    const statusEvents = h.sent.filter((s) => s.channel === 'github:status')
    expect(statusEvents).toHaveLength(2) // start()'s announcement, then tick()'s re-probe — not silent
    g.stop()
  })

  it('a repo with no configured remote is memoized and stops costing a spawn every tick (finding 4)', async () => {
    const h = harness({
      fetchPrList: async (repoPath): Promise<GhResult> => {
        h.fetches.push(repoPath)
        return { ok: false, stdout: '', stderr: 'no git remotes found' }
      }
    })
    const g = createGithubPrs(h.deps)
    await g.start()
    g.subscribe()
    await g.tick() // classifies no-remote and memoizes the repo
    expect(h.fetches).toHaveLength(1)
    h.advance(MIN_SPACING_MS + 60_000)
    await g.tick()
    expect(h.fetches).toHaveLength(1) // memoized — no repeat spawn for a repo that can never succeed
    await g.refresh({ force: true }) // a forced refresh must not resurrect it either
    expect(h.fetches).toHaveLength(1)
    g.stop()
  })
})

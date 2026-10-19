// GitHub lifecycle G6 (design §6.3, §10 "restart" and "external PR changes"; spec §28-§30): a lifecycle Run a killed Host
// left in its file is taken up by the next Host — its CI wait resumed with no second push, pull request or rerun, a round
// that was about to push pushed once, and a pull request merged meanwhile never pushed onto.
//
// **The next Host over the file the killed one left.** `boot()` builds what index.ts builds for a lifecycle Run, as the
// recovery rig (recovery.integration.test.ts) does for workers: a real `createHostOrch` on a temp profile,
// `composeHostDriving` over it, a real `createHostJournal` and `createHostWorktrees`, and the watch and the carrier
// composed as index.ts composes them. The profile's orchestration.json is written first, as the killed Host left it.
// Only GitHub is faked: `originOf` names a GitHub repository while git pushes to a local bare origin, and gh's reads and
// writes are answered by a recorder (g6 code map fact 37).
//
// **Portable:** every path comes from `tempDir`/`path.join`, git runs through the fixtures, and every wait is a bounded
// `vi.waitFor`.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { removeFixture } from '../core/testFixtures'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { composeHostDriving, type HostDrivingWiring } from './drivingWiring'
import { createHostOrch, type HostOrch } from './orch'
import { createHostJournal } from './hostJournal'
import { PtyRegistry } from './registry'
import { ProcRegistry } from './procRegistry'
import { createHostWorktrees } from './worktrees'
import type { HostSpawner } from './spawner'
import { createGithubWatch, type WatchedWorktree } from './githubWatch'
import { createLifecycleCi } from './lifecycleCi'
import { makeRepo, addOrigin, gitSync, tempDir } from '../core/worktrees/testRepo'
import { HOST_YIELD_JOURNAL } from '../core/host/protocol'
import { git as realGit, isCleanWorktree } from '../core/worktrees/git'
import { headOf, pushBranch } from '../core/github/lifecyclePush'
import { readCommitsOrNull } from '../core/github/prCreate'
import { emptyState, type OrchState } from '../core/orchestration/state'
import type { PrStateRead } from '../core/github/prState'
import type { GitHubBinding } from '../core/github/lifecycle'
import type { Provider } from '../core/types'
import { JournalReader } from '../core/continuity/journalReader'

const WAIT = { timeout: 20_000, interval: 20 }
const until = <T>(fn: () => T | Promise<T>): Promise<T> => vi.waitFor(fn, WAIT)

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

const POLICY = { ci: { mode: 'required' as const }, autoRerunInfrastructureFailures: true, maxInfrastructureReruns: 2, ciWaitMinutes: 90 }
const BRANCH = 'u/a'
const binding: GitHubBinding = { repository: 'o/r', number: 12, url: 'https://github.com/o/r/pull/12', baseBranch: 'main', headBranch: BRANCH, createdByAstera: true, boundAt: '2026-10-19T00:00:00.000Z' }

/** The profile: a repo on branch u/a one commit past main, a bare origin, and the state a killed Host left. */
async function profile(seed: (a: { repo: string; sha: string; since: string }) => OrchState) {
  const profileDir = await tempDir('astera-hostlifecycle-profile-')
  const home = await tempDir('astera-hostlifecycle-home-')
  const repo = await makeRepo('astera-hostlifecycle-repo-')
  const origin = await addOrigin(repo)
  cleanups.push(async () => {
    for (const d of [profileDir, home, repo, origin]) await removeFixture(d)
  })
  gitSync(repo, ['checkout', '-b', BRANCH])
  await fs.writeFile(path.join(repo, 'add.js'), 'module.exports = (a, b) => a + b\n')
  gitSync(repo, ['add', 'add.js'])
  gitSync(repo, ['commit', '-m', 'Fix add'])
  const sha = gitSync(repo, ['rev-parse', 'HEAD']).trim()
  // Job Continuity on: the Host journals what it does, the GITHUB_* rows included (G6, design §5.5)
  await fs.writeFile(path.join(profileDir, 'app-settings.json'), JSON.stringify({ orchAlwaysOnMigrated: true, jobContinuityEnabled: true }))
  await fs.writeFile(path.join(profileDir, 'worktrees.json'), JSON.stringify({ root: path.join(home, 'wt'), items: [] }))
  const configDir = path.join(home, 'cfg', 'acc_1')
  await fs.mkdir(configDir, { recursive: true })
  await fs.writeFile(path.join(configDir, '.credentials.json'), '{}')
  const account = { id: 'acc_1', label: 'acc_1', configDir, color: '#888', createdAt: '2026-10-08T00:00:00.000Z', provider: 'claude' as Provider }
  await fs.writeFile(path.join(profileDir, 'accounts.json'), JSON.stringify({ accounts: [account] }))
  // A minute ago, so the wait's grace and cap count from a moment the Host was down for
  const since = new Date(Date.now() - 60_000).toISOString()
  await fs.writeFile(path.join(profileDir, 'orchestration.json'), JSON.stringify(seed({ repo, sha, since })))
  return { profileDir, home, repo, origin, sha, since }
}

/** The state a killed Host left: a lifecycle Run whose lifecycle Task hands its round to the Host at github:ci. */
const lifecycleRun = (a: { repo: string; since: string; ciWait: Record<string, unknown>; github: Record<string, unknown> }): OrchState => ({
  ...emptyState(),
  jobs: [{ id: 'job_1', objective: 'fix add', cwd: a.repo, createdAt: a.since, convergence: {}, github: POLICY }],
  runs: [{ id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: a.since, worktree: a.repo, githubState: { binding, log: [], seq: 0, ...a.github } as never }],
  tasks: [
    { id: 'tsk_a', runId: 'run_1', title: 'a', spec: 's', deps: [], status: 'completed', consecutiveFailures: 0, createdAt: a.since, updatedAt: a.since },
    {
      id: 'tsk_l', runId: 'run_1', kind: 'lifecycle', title: 'GitHub 전달', spec: 's', deps: ['tsk_a'], status: 'validating', validateConfigIds: ['github:ci'],
      reviewRequested: true, consecutiveFailures: 0, createdAt: a.since, updatedAt: a.since, ciWait: a.ciWait as never
    }
  ]
})

const passed = (sha: string): PrStateRead => ({
  number: 12, url: binding.url, state: 'open', isDraft: true, headBranch: BRANCH, headSha: sha, commitSha: sha, baseBranch: 'main',
  suites: [{ app: 'github-actions', completed: true }],
  checks: [{ externalId: 'run:1', name: 'build', status: 'completed', conclusion: 'success', required: false, jobId: 1 }],
  rateLimit: { limit: 5000, remaining: 4900, resetAt: '2026-10-19T01:00:00Z' }
})

/** The next Host over the profile, with GitHub answered by `gh`. Its state is loaded as a first command loads it. */
async function boot(p: { profileDir: string; home: string; repo: string }, gh: { read?: PrStateRead; live?: 'open' | 'closed' | 'merged' }) {
  const logs: string[] = []
  const log = (m: string): void => void logs.push(m)
  const calls: string[] = []
  const registry = new PtyRegistry({
    spawn: () => ({ pid: 7000, onData() {}, onExit() {}, write() {}, resize() {}, kill() {}, pause() {}, resume() {} }),
    log
  })
  const procs = new ProcRegistry({ spawn: () => ({ pid: 1, onData() {}, onExit() {}, write() {}, kill() {} }), log })
  const srv = { hasApp: () => false, appsKeep: (_duty: string) => false, broadcast: () => {} }
  const box: { orch: HostOrch | null } = { orch: null }
  const orchOf = (): HostOrch => box.orch!
  const worktrees = createHostWorktrees({
    profileDir: p.profileDir, homeDir: p.home, ptys: registry, procs, getState: () => orchOf().state(), broadcast: () => {}, log,
    app: { hasApp: () => false, act: async () => { throw new Error('the rig’s app answers no act') } }, closeTimeoutMs: 500, pollMs: 10
  })
  await worktrees.load()
  const journal = createHostJournal({ profileDir: p.profileDir, writer: () => !srv.appsKeep(HOST_YIELD_JOURNAL), hostStartedAt: () => '2026-10-19T02:00:00.000Z', now: () => new Date().toISOString(), log })
  await journal.start()
  const spawner = {
    orchEnvNow: () => undefined,
    owns: () => true,
    startWorker: async (a: { dispatchId: string; runCwd: string }) => {
      calls.push('startWorker')
      const specPath = path.join(p.profileDir, 'orch', 'specs', `${a.dispatchId}.md`)
      await fs.mkdir(path.dirname(specPath), { recursive: true })
      await fs.writeFile(specPath, 'the rig’s spec')
      return { sessionId: `ses_${a.dispatchId}`, cwd: a.runCwd, specPath }
    },
    startCoordinator: async () => ({ sessionId: 'ses_coord' }),
    releaseWorker: async () => {},
    readWorker: async () => '',
    probeLimit: async () => null,
    readReviewFile: async () => null,
    makeRunWorktree: (a: Parameters<typeof worktrees.makeRunWorktree>[0]) => worktrees.makeRunWorktree(a),
    mergeWorktrees: (runCwd: string, paths: string[]) => worktrees.mergeWorktrees(runCwd, paths),
    removeWorktrees: (paths: string[]) => worktrees.removeWorktrees(paths),
    inFlight: () => 0,
    closeAndSettle: async () => {},
    trackedSessions: () => 0,
    sessionBusy: () => null,
    typeInto: () => false,
    isRetiring: () => false,
    prepareRollSpawn: async () => { throw new Error('not in this rig') },
    rollSpawn: () => { throw new Error('not in this rig') },
    statusLinePayload: async () => null,
    onSpawned: () => {},
    onRolloutLocated: () => {},
    onBusyChanged: () => {},
    retarget: () => {},
    createSession: async () => { throw new Error('not in this rig') }
  } as unknown as HostSpawner
  const wiring: HostDrivingWiring = composeHostDriving({
    profileDir: p.profileDir, platform: process.platform, env: { PATH: process.env.PATH }, registry, spawner, worktrees, orch: orchOf,
    server: () => srv, log, now: () => new Date().toISOString(), nowMs: () => Date.now(), every: () => () => {},
    after: (_ms: number, fn: () => void) => { const h = setTimeout(fn, 0); return () => clearTimeout(h) },
    killRunner: () => {}, journal
  })
  // The run's branch as the watch and the carrier know it; the registry has no entry for a repo that is its own root
  const worktreeOf = (q: string): WatchedWorktree | null => (q === p.repo ? { repoPath: p.repo, branch: BRANCH, baseRef: 'main' } : null)
  const originOf = async (): Promise<string> => 'git@github.com:o/r.git'
  const watch = createGithubWatch({
    record: (args) => orchOf().handle('runs-github-record', args),
    worktreeOf,
    baseBranch: async () => 'main',
    originOf,
    findOpenPrs: async () => (calls.push('findOpenPrs'), { ok: true, prs: [{ number: 12, url: binding.url }] as never }),
    readPrState: async () => (calls.push('readPrState'), gh.read ? { ok: true, read: gh.read } : { ok: false, kind: 'network', message: 'no read in this rig' }),
    ruleCheckNames: async () => ({ ok: true, names: [] }),
    readIssue: async () => ({ ok: false, kind: 'other', message: 'no issue' }) as never,
    readJobLog: async () => ({ ok: true, log: '' }),
    readAnnotations: async () => ({ ok: true, annotations: [] }),
    settle: (a) => wiring.checks.settleHandedOff(a),
    openGitHubGate: (a) => orchOf().handle('lifecycle-gate', { task: a.taskId, since: a.since, kind: a.kind, question: a.question, options: a.options }),
    ancestry: async () => 'unknown' as never,
    rerunCi: async () => (calls.push('rerunCi'), { ok: true }),
    lang: () => 'en',
    log
  })
  const ci = createLifecycleCi({
    worktreeOf,
    originOf,
    isClean: (cwd) => isCleanWorktree(cwd),
    readCommits: (cwd, base) => readCommitsOrNull(cwd, base),
    baseBranch: async () => 'main',
    push: (cwd, branch) => (calls.push('push'), pushBranch(realGit, cwd, branch)),
    headOf: (cwd, ref) => headOf(realGit, cwd, ref),
    findOpenPrs: async () => (calls.push('findOpenPrs'), { ok: true, prs: [] }),
    createDraftPr: async () => (calls.push('createDraftPr'), { ok: true, number: 99, url: 'https://github.com/o/r/pull/99' }),
    readPr: async () => (calls.push('readPr'), { ok: true, state: gh.live ?? 'open' }),
    record: (args) => orchOf().handle('runs-github-record', args),
    recordWait: (args) => orchOf().handle('lifecycle-ci-wait', args),
    settle: (a) => wiring.checks.settleHandedOff(a),
    openGitHubGate: (a) => orchOf().handle('lifecycle-gate', { task: a.taskId, since: a.since, kind: a.kind, question: a.question, options: a.options }),
    schedule: () => {},
    lang: () => 'en',
    log
  })
  const orch = createHostOrch({
    profileDir: p.profileDir, version: '9.9.9', now: () => new Date().toISOString(), hostStartedAt: () => '2026-10-19T02:00:00.000Z',
    runningSessions: () => 0, aliveSessionIds: () => new Set<string>(), act: async () => undefined, hasApp: () => false,
    onState: (state) => {
      watch.onState(state)
      ci.onState(state)
    },
    log,
    sessions: {
      listSessions: async () => [], readSession: async () => ({ cols: 80, rows: 24, screen: [], scrollback: [] }), sendSession: async () => {},
      readChat: async () => [], sendChat: async () => {}, serial: (_id, run) => run()
    },
    local: spawner,
    specsDir: path.join(p.profileDir, 'orch', 'specs'),
    worktrees,
    journal,
    ...wiring.orchHooks,
    onLoaded: () => {
      wiring.orchHooks.onLoaded?.()
      watch.onState(orchOf().state())
      ci.onState(orchOf().state())
    }
  })
  box.orch = orch
  cleanups.push(async () => {
    watch.stop()
    wiring.dispose()
    journal.close()
    registry.killAll()
  })
  return { orch, watch, ci, calls, logs, state: () => orch.state() }
}

const lifecycleTaskOf = (s: OrchState) => s.tasks.find((t) => t.id === 'tsk_l')!

const journalTypes = (profileDir: string): string[] => {
  const r = new JournalReader(path.join(profileDir, 'orch', 'continuity.sqlite'))
  try {
    return r.eventsFor('run_1').map((e) => e.type)
  } finally {
    r.close()
  }
}

describe('a lifecycle Run after a Host restart (GitHub lifecycle G6, design §6.3, §10)', { timeout: 60_000 }, () => {
  // Characterization: G3a gave the restart cleanup its lifecycle branch and G3b1 the watch's round from state, so this
  // passes on the code before G6 once the Host has loaded (g6 code map facts 8-11)
  // Loaded as the early load loads a Remote Host with no client (loadUnattended, host/earlyLoad.ts), and journaled
  it('a CI wait the killed Host left is read at once and settled once: no push, no pull request, no rerun, and journaled', async () => {
    const p = await profile(({ repo, sha, since }) => lifecycleRun({ repo, since, ciWait: { since, done: [], pr: 12, sha }, github: { lastPushedSha: sha, pr: { state: 'open', isDraft: true, baseBranch: 'main' } } }))
    const h = await boot(p, { read: passed(p.sha) })
    await h.orch.loadUnattended()
    await h.watch.tick()
    await until(() => expect(lifecycleTaskOf(h.state()).status).not.toBe('validating'))
    const task = lifecycleTaskOf(h.state())
    expect(task.ciWait).toBeUndefined()
    expect(task.checks?.find((c) => c.configId === 'github:ci')?.status).toBe('passed')
    expect(h.calls.filter((c) => c === 'push' || c === 'createDraftPr' || c === 'rerunCi')).toEqual([])
    expect(h.calls.filter((c) => c === 'readPrState')).toHaveLength(1)
    await until(() => expect(journalTypes(p.profileDir)).toContain('GITHUB_CI_PASSED'))
  })

  it('a round the killed Host was about to push is pushed once, to the pull request it is bound to, and waits', async () => {
    const p = await profile(({ repo, since }) => lifecycleRun({ repo, since, ciWait: { since, done: [] }, github: { pr: { state: 'open', isDraft: true, baseBranch: 'main' } } }))
    const h = await boot(p, {})
    await h.orch.ready()
    await h.ci.drain()
    await until(() => expect(lifecycleTaskOf(h.state()).ciWait?.sha).toBe(p.sha))
    expect(gitSync(p.origin, ['rev-parse', `refs/heads/${BRANCH}`]).trim()).toBe(p.sha)
    expect(h.calls.filter((c) => c === 'push')).toHaveLength(1)
    expect(h.calls).not.toContain('createDraftPr')
    expect(h.calls).not.toContain('findOpenPrs')
    expect(h.state().runs[0].githubState?.lastPushedSha).toBe(p.sha)
  })

  // spec §30, map facts 21-22: merged on GitHub while the lifecycle Task repaired and the Host was down
  it('a pull request merged meanwhile is never pushed onto: the round asks, and origin keeps no branch', async () => {
    const p = await profile(({ repo, since }) => lifecycleRun({ repo, since, ciWait: { since, done: [] }, github: { pr: { state: 'open', isDraft: true, baseBranch: 'main' } } }))
    const h = await boot(p, { live: 'merged' })
    await h.orch.ready()
    await h.ci.drain()
    await until(() => expect(h.state().gates.filter((g) => g.status === 'open').map((g) => g.kind)).toEqual(['github-pr-closed']))
    expect(h.calls).not.toContain('push')
    expect(() => gitSync(p.origin, ['rev-parse', '--verify', `refs/heads/${BRANCH}`])).toThrow()
    expect(lifecycleTaskOf(h.state()).ciWait?.sha).toBeUndefined()
  })
})

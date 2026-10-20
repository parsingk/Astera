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
// **The repair loop (acceptance fixes Task 7).** The same Host, carried on from a CI failure: the repair a worker does in
// the Run root, the carrier pushing its commit, the watch judging only the head pushed, the second provider's review, and
// merge-ready; and a failure outside the code rerun instead. The workers are the rig's: it commits and reports for them.
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
import { ancestry, headOf, pushBranch } from '../core/github/lifecyclePush'
import { readCommitsOrNull } from '../core/github/prCreate'
import { emptyState, type OrchState } from '../core/orchestration/state'
import type { PrStateRead } from '../core/github/prState'
import type { GitHubBinding, GitHubCiCheck } from '../core/github/lifecycle'
import type { OrchCaller } from '../core/host/orchProtocol'
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
  // A claude account the work ran on, and a codex one: a review is a second provider's
  const accounts = []
  for (const [id, provider] of [['acc_1', 'claude'], ['acc_2', 'codex']] as const) {
    const configDir = path.join(home, 'cfg', id)
    await fs.mkdir(configDir, { recursive: true })
    await fs.writeFile(path.join(configDir, provider === 'codex' ? 'auth.json' : '.credentials.json'), '{}')
    accounts.push({ id, label: id, configDir, color: '#888', createdAt: '2026-10-08T00:00:00.000Z', provider: provider as Provider })
  }
  await fs.writeFile(path.join(profileDir, 'accounts.json'), JSON.stringify({ accounts }))
  // A minute ago, so the wait's grace and cap count from a moment the Host was down for
  const since = new Date(Date.now() - 60_000).toISOString()
  await fs.writeFile(path.join(profileDir, 'orchestration.json'), JSON.stringify(seed({ repo, sha, since })))
  return { profileDir, home, repo, origin, sha, since }
}

/** The state a killed Host left: a lifecycle Run whose lifecycle Task hands its round to the Host at github:ci. Its
 *  ordinary Task was a worker's, in the Run root: a repair rolls through that worker's provider and account. */
const lifecycleRun = (a: { repo: string; since: string; ciWait: Record<string, unknown>; github: Record<string, unknown> }): OrchState => ({
  ...emptyState(),
  jobs: [{ id: 'job_1', objective: 'fix add', cwd: a.repo, createdAt: a.since, convergence: {}, github: POLICY }],
  runs: [{ id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: a.since, worktree: a.repo, githubState: { binding, log: [], seq: 0, ...a.github } as never }],
  dispatches: [
    {
      id: 'dsp_a', taskId: 'tsk_a', provider: 'claude', accountId: 'acc_1', sessionId: 'ses_a', cwd: a.repo, specPath: '', startedAt: a.since,
      endedAt: a.since, outcome: 'succeeded', workerState: 'ready', retained: false
    }
  ],
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

/** A failed build on `sha`, its job printing `log` (the rig's job log); a CI run's attempt for a rerun to name. */
const failed = (sha: string, over: Partial<GitHubCiCheck> = {}): PrStateRead => ({
  ...passed(sha),
  checks: [{ externalId: 'run:1', name: 'build', status: 'completed', conclusion: 'failure', required: false, jobId: 1, ciRunId: 9, ciRunAttempt: 1, ...over }]
})

/** What GitHub answers the next Host, read at each call: a test changes `read` as CI moves. */
interface FakeGitHub {
  read?: PrStateRead
  live?: 'open' | 'closed' | 'merged'
  /** The failed job's log. */
  log?: string
}

/** The workers the Host started, as the spawner was asked. */
interface Spawn {
  dispatchId: string
  taskId: string
  sessionId: string
  cwd: string
  specPath: string
}

/** The next Host over the profile, with GitHub answered by `gh`. Its state is loaded as a first command loads it. */
async function boot(p: { profileDir: string; home: string; repo: string }, gh: FakeGitHub) {
  const logs: string[] = []
  const log = (m: string): void => void logs.push(m)
  const calls: string[] = []
  const spawns: Spawn[] = []
  // The watch's clock runs ahead of the Host's on `advance`, so its next read is due without waiting it out
  const skew = { ms: 0 }
  /** The rerun Astera had written down as pending when it asked gh for it. */
  const pendingAtRerun: unknown[] = []
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
    startWorker: async (a: { dispatchId: string; taskId: string; runCwd: string; worktree?: string }) => {
      calls.push('startWorker')
      const specPath = path.join(p.profileDir, 'orch', 'specs', `${a.dispatchId}.md`)
      await fs.mkdir(path.dirname(specPath), { recursive: true })
      await fs.writeFile(specPath, 'the rig’s spec')
      // A repair names the folder it works in, the Run root; a reviewer reads the Run's own
      const cwd = a.worktree !== undefined && a.worktree !== 'new' && a.worktree !== 'current' ? a.worktree : a.runCwd
      spawns.push({ dispatchId: a.dispatchId, taskId: a.taskId, sessionId: `ses_${a.dispatchId}`, cwd, specPath })
      return { sessionId: `ses_${a.dispatchId}`, cwd, specPath }
    },
    startCoordinator: async () => ({ sessionId: 'ses_coord' }),
    releaseWorker: async () => {},
    readWorker: async () => '',
    probeLimit: async () => null,
    // The real spawner's body: a missing file is null, any other failure throws
    readReviewFile: async (f: string) => {
      try {
        return await fs.readFile(f, 'utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw e
      }
    },
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
    now: () => Date.now() + skew.ms,
    random: () => 0.5,
    record: (args) => orchOf().handle('runs-github-record', args),
    worktreeOf,
    baseBranch: async () => 'main',
    originOf,
    findOpenPrs: async () => (calls.push('findOpenPrs'), { ok: true, prs: [{ number: 12, url: binding.url }] as never }),
    readPrState: async () => (calls.push('readPrState'), gh.read ? { ok: true, read: gh.read } : { ok: false, kind: 'network', message: 'no read in this rig' }),
    ruleCheckNames: async () => ({ ok: true, names: [] }),
    readIssue: async () => ({ ok: false, kind: 'other', message: 'no issue' }) as never,
    readJobLog: async () => ({ ok: true, log: gh.log ?? '' }),
    readAnnotations: async () => ({ ok: true, annotations: [] }),
    settle: (a) => wiring.checks.settleHandedOff(a),
    openGitHubGate: (a) => orchOf().handle('lifecycle-gate', { task: a.taskId, since: a.since, kind: a.kind, question: a.question, options: a.options }),
    // Real git: whether a head GitHub shows is Astera's own earlier one is the repo's history
    ancestry: (cwd, head, sha) => ancestry(realGit, cwd, head, sha),
    rerunCi: async () => {
      calls.push('rerunCi')
      pendingAtRerun.push(orchOf().state().runs[0].githubState?.rerunPending)
      return { ok: true }
    },
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
    // The `github-*` deps as index.ts gives them, for what a round after the first needs: the folder's origin, which
    // lifecycle-ci-begin asks before the Host keeps a round (L24). gh itself is faked per call above
    github: {
      run: (async () => { throw new Error('the rig’s gh is faked per call') }) as never,
      createPr: async () => { throw new Error('not in this rig') },
      readCommits: async () => { throw new Error('not in this rig') },
      isClean: (wt) => isCleanWorktree(wt),
      originOf
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
  const cliCaller: OrchCaller = { role: 'cli', toOthers: () => {} }
  return {
    orch, watch, ci, wiring, calls, logs, spawns, pendingAtRerun,
    state: () => orch.state(),
    /** The watch's clock moves `ms` on, then it reads what is due. */
    advance: async (ms: number): Promise<void> => {
      skew.ms += ms
      await watch.tick()
    },
    /** The worker `s` reports, as its own `astera send` does. */
    workerReports: async (s: Spawn, outcome: 'succeeded' | 'failed'): Promise<void> => {
      const r = await orch.call({
        cmd: 'send',
        args: { type: 'worker_done', taskId: s.taskId, dispatchId: s.dispatchId, outcome, subject: 'done', body: 'the rig’s worker is done' },
        sessionId: s.sessionId,
        from: cliCaller
      })
      if (r.status !== 200) throw new Error(`rig: worker_done answered ${r.status} ${JSON.stringify(r.body)}`)
    }
  }
}

const lifecycleTaskOf = (s: OrchState) => s.tasks.find((t) => t.id === 'tsk_l')!

type Profile = Awaited<ReturnType<typeof profile>>
type Booted = Awaited<ReturnType<typeof boot>>

/** A Run waiting on CI for the first head, which the killed Host pushed. */
async function waitingOnFirstHead(gh: FakeGitHub): Promise<{ p: Profile; h: Booted }> {
  const p = await profile(({ repo, sha, since }) => lifecycleRun({ repo, since, ciWait: { since, done: [], pr: 12, sha }, github: { lastPushedSha: sha, pr: { state: 'open', isDraft: true, baseBranch: 'main' } } }))
  gitSync(p.repo, ['push', 'origin', BRANCH])
  const h = await boot(p, gh)
  await h.orch.loadUnattended()
  return { p, h }
}

/** CI failed on the first head and the Host repairs it: the repair's worker commits a fix in the folder it was given and
 *  reports, and the carrier pushes that commit. The new head, once the round waits on it. */
async function repairedAndPushed(p: Profile, h: Booted): Promise<{ repair: Spawn; head: string }> {
  await h.watch.tick()
  await until(() => expect(h.spawns).toHaveLength(1))
  const repair = h.spawns[0]
  await fs.writeFile(path.join(repair.cwd, 'add.js'), 'module.exports = (a, b) => Number(a) + Number(b)\n')
  gitSync(repair.cwd, ['add', 'add.js'])
  gitSync(repair.cwd, ['commit', '-m', 'Add numbers, not strings'])
  const head = gitSync(repair.cwd, ['rev-parse', 'HEAD']).trim()
  await h.workerReports(repair, 'succeeded')
  await until(async () => {
    await h.wiring.driving.tick()
    await h.ci.drain()
    expect(lifecycleTaskOf(h.state()).ciWait?.sha).toBe(head)
  })
  return { repair, head }
}

const dispatchOf = (h: Booted, s: Spawn) => h.state().dispatches.find((d) => d.id === s.dispatchId)!

/** The lifecycle Task's reviewer, started by the Host's driving after `before` other workers. */
async function reviewerStarted(h: Booted, before: number): Promise<Spawn> {
  await until(async () => {
    await h.wiring.driving.tick()
    expect(h.spawns).toHaveLength(before + 1)
  })
  return h.spawns[before]
}

// Acceptance fixes Task 7 (spec §15-§20, §26, §28): the repair loop through the Host's own watch, carrier, validator and
// reviewer, with only GitHub faked — each piece is tested alone elsewhere; here they are one loop
describe('the GitHub repair loop on the Host (acceptance fixes Task 7)', { timeout: 60_000 }, () => {
  it('a CI failure is repaired in the Run root, its commit pushed once, and CI and the review passing on it make the Run merge-ready', async () => {
    const gh: FakeGitHub = { log: 'AssertionError: expected "12" to be 3' }
    const { p, h } = await waitingOnFirstHead(gh)
    gh.read = failed(p.sha)
    const { repair, head } = await repairedAndPushed(p, h)
    expect(dispatchOf(h, repair).repair).toBeDefined()
    expect(repair.cwd).toBe(p.repo)
    expect(gitSync(p.origin, ['rev-parse', `refs/heads/${BRANCH}`]).trim()).toBe(head)
    expect(h.state().runs[0].githubState?.lastPushedSha).toBe(head)

    gh.read = passed(head)
    await h.watch.tick()
    const reviewer = await reviewerStarted(h, 1)
    await until(() => expect(dispatchOf(h, reviewer)).toMatchObject({ review: true, reviewHead: head, specPath: reviewer.specPath }))
    await fs.writeFile(`${reviewer.specPath}.review.json`, JSON.stringify({ issues: [] }))
    await h.workerReports(reviewer, 'succeeded')
    await until(() => expect(lifecycleTaskOf(h.state()).status).toBe('completed'))
    expect(h.state().runs[0].githubState?.mergeReady).toMatchObject({ pullRequestNumber: 12, headSha: head, requiredCiPassed: true, reviewPassed: true })
    expect(h.calls.filter((c) => c === 'push')).toHaveLength(1)
    expect(h.calls.filter((c) => c === 'createDraftPr' || c === 'rerunCi')).toEqual([])
    expect(h.state().gates.filter((g) => g.status === 'open')).toEqual([])
  })

  // spec §26: a verdict is the head's it was read on — GitHub still showing the first head, or the new head with the first
  // head's checks, settles nothing, and starts no second repair
  it('a verdict on the old head after the new push settles nothing; CI on the new head does', async () => {
    const gh: FakeGitHub = { log: 'AssertionError: expected "12" to be 3' }
    const { p, h } = await waitingOnFirstHead(gh)
    gh.read = failed(p.sha)
    const { head } = await repairedAndPushed(p, h)
    const reads = (): number => h.calls.filter((c) => c === 'readPrState').length
    const before = reads()

    await h.watch.tick() // GitHub has not caught up: the first head, its build still failing
    gh.read = { ...failed(p.sha), headSha: head } // the new head, shown with the first head's checks
    await h.advance(150_000)
    expect(reads()).toBe(before + 2)
    expect(lifecycleTaskOf(h.state())).toMatchObject({ status: 'validating', ciWait: { sha: head } })
    expect(h.spawns).toHaveLength(1)
    expect(h.state().gates.filter((g) => g.status === 'open')).toEqual([])

    gh.read = passed(head)
    await h.advance(150_000)
    await until(() => expect(lifecycleTaskOf(h.state()).status).toBe('reviewing'))
    expect(lifecycleTaskOf(h.state()).checks?.find((c) => c.configId === 'github:ci')?.status).toBe('passed')
  })

  // spec §17: a cause outside the code is rerun, not repaired; the rerun is written down before gh is asked (acceptance
  // fixes Task 5) and recorded after
  it('an infrastructure failure is rerun, not repaired, and the rerun is pending while gh is asked', async () => {
    const gh: FakeGitHub = {}
    const { p, h } = await waitingOnFirstHead(gh)
    gh.read = failed(p.sha, { conclusion: 'startup-failure' })
    await h.watch.tick()
    await until(() => expect(h.state().runs[0].githubState?.reruns).toHaveLength(1))
    const asked = { ciRunId: 9, attempt: 1, sha: p.sha, check: 'build', by: 'astera' }
    expect(h.pendingAtRerun).toEqual([expect.objectContaining(asked)])
    expect(h.state().runs[0].githubState?.reruns?.[0]).toMatchObject(asked)
    expect(h.state().runs[0].githubState?.rerunPending).toBeUndefined()
    expect(h.spawns).toEqual([])
    expect(lifecycleTaskOf(h.state()).status).toBe('validating')

    gh.read = { ...passed(p.sha), checks: [{ externalId: 'run:2', name: 'build', status: 'completed', conclusion: 'success', required: false, jobId: 2, ciRunId: 9, ciRunAttempt: 2 }] }
    await h.advance(30_000)
    await until(() => expect(lifecycleTaskOf(h.state()).status).toBe('reviewing'))
    await reviewerStarted(h, 0)
    expect(h.calls.filter((c) => c === 'rerunCi')).toHaveLength(1)
    expect(h.spawns.map((s) => dispatchOf(h, s).review === true)).toEqual([true])
  })
})

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

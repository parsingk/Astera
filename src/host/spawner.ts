// The Host's own spawn path (Host S2 design §2.1–§2.5, §2.8): orchestration workers and coordinators
// started in the Host's pty registry, so they run with no Astera window open.
//
// **The same code the app spawns through, not a second copy.** SessionManager builds the command
// line and the note, OrchCoordinator writes the spec and the launch prompt, and startWorkerWithChain
// and startCoordinatorSession are the start paths the app's registerIpc wiring calls. What this file
// adds is only what the app supplies from its own state there: the account list (read-only from
// accounts.json), the permission mode (read-only from app-settings.json), the environment (the Host's
// own minus what its start added, D4), the pty factory (the Host's registry, plus `pty-opened`), and
// worktrees (the Host's own registry, Host S3 §3.1) — the fork behind `--worktree new` and the three
// `OrchServerDeps` this file no longer answers by refusing.
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { comparablePath } from '../core/files/tree'
import { randomUUID } from 'node:crypto'
import type { HostMessage, PtyEntry } from '../core/host/protocol'
import { hostCliPaths, hostWorkerBaseEnv } from '../core/host/spawn'
import type { OrchServerDeps } from '../core/orchestration/command'
import type { OrchState } from '../core/orchestration/state'
import { OrchCoordinator, type CoordinatorDeps } from '../core/orchestration/exec/coordinator'
import { WorkerTails } from '../core/orchestration/exec/tail'
import { releaseArgsFor } from '../core/orchestration/exec/release'
import { makeLimitProbe } from '../core/orchestration/exec/limitProbe'
import { ensureShuttle } from '../core/orchestration/exec/shuttle'
import {
  preTrustWorkspace,
  startCoordinatorSession,
  startWorkerWithChain
} from '../core/orchestration/exec/workerStart'
import { readAccountEntries } from '../core/accounts/accountsFile'
import { readAgentPermissionMode } from '../core/settings/agentPermissionMode'
import { RepairNeeded } from '../core/settings/repairNeeded'
import { HostRetiring } from '../core/host/hostRetiring'
import { refusedBeforeActing, undoneBeforeFailing } from '../core/host/orchProtocol'
import { findRollout as findRolloutOnDisk } from '../core/rolling/codexLocate'
import { descriptorOf, makeDescriptors } from '../core/providers/descriptor'
import { providerOf } from '../core/providers/meta'
import { SessionManager } from '../core/sessions/manager'
import type { PtyFactory, PtyLike } from '../core/sessions/pty'
import { StatusLineManager, resolveNodePath } from '../core/sessions/statusline'
import { BusyScanner } from '../core/terminal/busy'
import { previewShotsDir } from '../core/preview/shotsDir'
import type { Account } from '../core/types'
import type { PtyRegistry } from './registry'
import type { HostWorktrees } from './worktrees'

export type HostLocalName =
  | 'startWorker'
  | 'startCoordinator'
  | 'releaseWorker'
  | 'readWorker'
  | 'probeLimit'
  | 'readReviewFile'
  | 'makeRunWorktree'
  | 'mergeWorktrees'
  | 'removeWorktrees'

export interface HostLocal {
  startWorker: OrchServerDeps['startWorker']
  startCoordinator: NonNullable<OrchServerDeps['startCoordinator']>
  releaseWorker: OrchServerDeps['releaseWorker']
  readWorker: OrchServerDeps['readWorker']
  probeLimit: NonNullable<OrchServerDeps['probeLimit']>
  readReviewFile: NonNullable<OrchServerDeps['readReviewFile']>
  makeRunWorktree: NonNullable<OrchServerDeps['makeRunWorktree']>
  mergeWorktrees: NonNullable<OrchServerDeps['mergeWorktrees']>
  removeWorktrees: NonNullable<OrchServerDeps['removeWorktrees']>
  /** Whether this call is the Host's to answer (R1). */
  owns(name: HostLocalName, args: unknown[]): boolean
}

export interface HostSpawnerDeps {
  profileDir: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  homeDir: string
  registry: PtyRegistry
  broadcast(m: HostMessage): void
  getState(): OrchState
  log(m: string): void
  /** The Host's own worktree registry (Host S3, §3.1): the fork behind `--worktree new`, and the three
   *  `OrchServerDeps` names this file used to refuse. */
  worktrees: Pick<HostWorktrees, 'fork' | 'makeRunWorktree' | 'mergeWorktrees' | 'removeWorktrees'>
  /** Whether an attached app still does worktree work itself (`server.appKeeps`, ruling R4). Asked
   *  fresh on every `owns` call — an app can attach or detach between two of them. */
  appKeepsWorktrees(): boolean
  /** Test injection; defaults to existsSync. */
  exists?(p: string): boolean
  /** Test injection; defaults to the scan the app's CodexRolloutWatcher runs. */
  findRollout?: typeof findRolloutOnDisk
  /** How often a codex session's rollout is looked for: the watcher's POLL_MS. */
  locatePollMs?: number
  /** How long a codex session's rollout is looked for before the Host gives up. */
  locateForMs?: number
  /** Test injection; defaults to readAccountEntries. */
  readAccounts?: (file: string) => Promise<Account[]>
}

export interface HostSpawner extends HostLocal {
  /** How many worker and coordinator starts are under way right now. */
  inFlight(): number
  /** From now on startWorker/startCoordinator reject with "the Host is retiring…"; resolves when every
   *  spawn in flight has settled, or after `ms`, whichever is first. */
  closeAndSettle(ms: number): Promise<void>
  /** How many session records its SessionManager holds (M3): the live ones, once exits are forgotten. */
  trackedSessions(): number
}

type SpawnOpts = Parameters<CoordinatorDeps['spawnSession']>[0]

/** What one start did, filled in as it runs (Host S3 follow-up A36): whether its own pty was opened,
 *  the folder a `--worktree new` fork made for it, and whether the permission setting refused the
 *  spawn (follow-up round m6). Built per start, because two starts can be in flight at once and each
 *  must answer only for itself. */
interface StartTrace {
  opened: boolean
  forked: string | null
  settingsRefused: boolean
}

const LOCATE_POLL_MS = 1_000
const LOCATE_FOR_MS = 10 * 60_000

/** A promise made once, on first use. The shuttle and the statusLine files are written at the first
 *  local spawn and never at startup (R6): a Host that is constructed and never asked to spawn touches
 *  nothing. A failed attempt is not kept, so the next spawn tries again rather than failing forever. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null
  return () => {
    if (!p) p = make().catch((err) => { p = null; throw err })
    return p
  }
}

/** The PtyFactory SessionManager spawns through: the Host's own registry, plus the `pty-opened`
 *  broadcast (§2.3). Exported for the test.
 *
 *  **One registry subscription per kind, fanned out by pty id**, rather than one per pty: the
 *  registry's listener set only grows, and a subscription per spawn would keep a dead worker's
 *  callbacks for the rest of the Host's life. The per-id entries go when the pty exits. */
export function hostPtyFactory(a: { registry: PtyRegistry; onOpened(entry: PtyEntry): void }): PtyFactory {
  const dataCbs = new Map<string, Array<(data: string) => void>>()
  const exitCbs = new Map<string, Array<(e: { exitCode: number }) => void>>()
  a.registry.onData((id, data) => {
    for (const cb of dataCbs.get(id) ?? []) cb(data)
  })
  a.registry.onExit((id, exitCode) => {
    const cbs = exitCbs.get(id) ?? []
    dataCbs.delete(id)
    exitCbs.delete(id)
    for (const cb of cbs) cb({ exitCode })
  })
  const add = <T>(m: Map<string, T[]>, id: string, cb: T): void => {
    const list = m.get(id)
    if (list) list.push(cb)
    else m.set(id, [cb])
  }
  return (file, args, opts) => {
    const id = randomUUID()
    const res = a.registry.open({
      id,
      file,
      args,
      opts: { cwd: opts.cwd, cols: opts.cols, rows: opts.rows, env: opts.env },
      meta: opts.meta
    })
    // Thrown, so SessionManager.spawn throws and worker-start rolls its Dispatch back (§8.5).
    if (!res.ok) throw new Error(res.error)
    a.onOpened(a.registry.list().find((e) => e.id === id)!)
    const pty: PtyLike = {
      pid: res.pid,
      onData: (cb) => add(dataCbs, id, cb),
      onExit: (cb) => add(exitCbs, id, cb),
      write: (d) => a.registry.write(id, d),
      resize: (c, r) => a.registry.resize(id, c, r),
      kill: () => a.registry.kill(id),
      pause: () => a.registry.pause(id),
      resume: () => a.registry.resume(id),
      remember: (patch) => a.registry.note(id, patch),
      outlivesApp: true
    }
    return pty
  }
}

/** null, with one log line naming the missing variables, when the Host was started without the
 *  CLI paths — then every Host-local name takes its old route (R1). */
export function createHostSpawner(d: HostSpawnerDeps): HostSpawner | null {
  const exists = d.exists ?? existsSync
  const cli = hostCliPaths(d.env, exists)
  if ('missing' in cli) {
    d.log(
      `Host-local spawn is off: ${cli.missing.join(', ')} not set — worker-start and friends are answered by the app as before`
    )
    return null
  }
  const { profileDir, platform, homeDir, registry, log } = d
  const readAccounts = d.readAccounts ?? readAccountEntries
  const descriptors = makeDescriptors(platform)
  // The rule core.ts uses for the app's StatusLineManager, so the two write the same settings files.
  const statusLine = new StatusLineManager(
    profileDir,
    platform === 'win32' ? 'node' : resolveNodePath(d.env as { PATH?: string }, existsSync, platform)
  )
  const ensured = once(() => statusLine.ensureFiles())
  const shuttlePath = once(() =>
    ensureShuttle({ dir: path.join(profileDir, 'orch'), execPath: cli.exec, entryPath: cli.entry })
  )
  const specsDir = path.join(profileDir, 'orch', 'specs')
  const settingsPath = path.join(profileDir, 'app-settings.json')
  const accountsPath = path.join(profileDir, 'accounts.json')
  const tails = new WorkerTails()
  /** dispatchId → the session this Host started it on. The Host's tail follows that session only: an
   *  app-side roll rekeys the Dispatch and re-points the app's own tail (its onRolled), not this one. */
  const startedOn = new Map<string, string>()
  const busyOf = new Map<string, { scanner: BusyScanner; busy: boolean }>()
  const findRollout = d.findRollout ?? findRolloutOnDisk
  const locatePollMs = d.locatePollMs ?? LOCATE_POLL_MS
  const locateForMs = d.locateForMs ?? LOCATE_FOR_MS
  /** ptyId → the codex sessions still looking for their rollout, in start order (`seq`). */
  const looking = new Map<string, { accountId: string; cwd: string; seq: number }>()
  let lookSeq = 0

  /** How many ptys this spawner has opened. Read around `sessions.spawn`, which is synchronous, so the
   *  count can only move there by that call's own pty (A36's "was a process started"). */
  let opens = 0
  const factory = hostPtyFactory({
    registry,
    onOpened: (entry) => {
      opens += 1
      // The pty is already running, so a broadcast that throws must not fail the spawn: the Dispatch
      // would roll back over a live worker. The app finds the session on its next reattach sweep.
      try {
        d.broadcast({ t: 'pty-opened', entry })
      } catch (err) {
        log(`pty-opened broadcast failed pty=${entry.id}: ${String(err)}`)
      }
    }
  })
  // The high-water mark is infinite because the Host has no renderer acks: a finite one would throttle
  // every Host-spawned worker to one chunk per RESUME_FAILSAFE_MS. The app keeps its own backpressure
  // when it adopts the pty.
  const sessions = new SessionManager(
    factory,
    descriptors,
    Number.POSITIVE_INFINITY,
    0,
    homeDir,
    (id, account, o) => statusLine.spawnConfig(id, account, o),
    [previewShotsDir(profileDir)],
    hostWorkerBaseEnv(d.env)
  )
  sessions.onExit = (e) => {
    sessions.forget(e.sessionId)
  }

  // Output taps. Keyed by the session id in the note, which is what the tails and the busy verdict
  // are asked by. Neither can throw, and the registry isolates its listeners anyway.
  registry.onData((ptyId, data) => {
    const m = registry.metaOf(ptyId)
    if (m?.kind !== 'session') return
    tails.push(m.id, data)
    let b = busyOf.get(m.id)
    if (!b) busyOf.set(m.id, (b = { scanner: new BusyScanner(), busy: false }))
    b.busy = b.scanner.push(data)
  })
  registry.onExit((ptyId) => {
    const m = registry.metaOf(ptyId)
    if (m?.kind === 'session') busyOf.delete(m.id)
  })

  /** Whether this registry ever held a pty for the session, alive or ended. One it never held was
   *  spawned by the app in its own node-pty (the unresponsive-Host fallback), so it is the app's to type
   *  into or to kill (review M2). */
  const held = (sessionId: string): boolean =>
    registry.list().some((e) => e.meta?.kind === 'session' && e.meta.id === sessionId)
  const alive = (ptyId: string): boolean => registry.list().some((e) => e.id === ptyId && e.alive)
  /** The watcher's claimed(): every rollout a live session's note already holds, other than this pty's.
   *  The notes are the one list both processes write to: the Host here, the app's watcher through
   *  `remember`. */
  const claimed = (ptyId: string): string[] => {
    const out: string[] = []
    for (const e of registry.list()) {
      const p = e.meta?.restore.rolloutPath
      if (e.alive && e.id !== ptyId && typeof p === 'string' && p !== '') out.push(p)
    }
    return out
  }
  /** The watcher's mayClaim(): of the sessions still looking in one account and folder, only the one
   *  that started last may claim, because "newest file created after I started" is only its answer. By
   *  start order rather than by `since`, since two Host spawns can share a millisecond. */
  const mayClaim = (ptyId: string): boolean => {
    const self = looking.get(ptyId)!
    for (const [id, e] of looking)
      if (id !== ptyId && e.accountId === self.accountId && comparablePath(e.cwd) === comparablePath(self.cwd) && e.seq > self.seq)
        return false
    return true
  }

  /** §2.5: what the app's CodexRolloutWatcher does for the codex sessions it spawns, for the ones this
   *  Host spawns. The scan works only right after a real spawn (an adopted session can never be scanned
   *  for), so the Host writes the mapping into the note, where the app's adopter reads it
   *  (codexRolloutFromNote). It stops at a hit, when the pty exits, or after `locateForMs`. */
  const locateRollout = (ptyId: string, sessionId: string, account: Account, cwd: string, since: number): void => {
    looking.set(ptyId, { accountId: account.id, cwd, seq: lookSeq++ })
    const giveUpAt = since + locateForMs
    const stop = (): void => {
      looking.delete(ptyId)
    }
    const tick = async (): Promise<void> => {
      if (!alive(ptyId)) return stop()
      if (Date.now() >= giveUpAt) {
        log(`no codex rollout found for session=${sessionId} in ${locateForMs}ms — its note carries no rollout`)
        return stop()
      }
      if (mayClaim(ptyId)) {
        const found = await findRollout({ configDir: account.configDir, cwd, since, excludePaths: claimed(ptyId) })
        if (!alive(ptyId)) return stop()
        // Another session can claim it across the await: re-checked, as the watcher does.
        if (found && !claimed(ptyId).includes(found.path)) {
          registry.note(ptyId, { rolloutPath: found.path, codexSessionId: found.sessionId })
          log(`codex rollout mapped session=${sessionId} path=${found.path}`)
          return stop()
        }
      }
      schedule()
    }
    const schedule = (): void => {
      setTimeout(() => {
        tick().catch((err) => {
          // One failed scan must not end the search: the next tick tries again, as the watcher's does.
          log(`codex rollout locate error session=${sessionId}: ${String(err)}`)
          schedule()
        })
      }, locatePollMs).unref()
    }
    schedule()
  }

  /** Task 4's ruling: a settings file the Host cannot read may have said 'manual', so it is never read
   *  as the bypass. The spawn is refused with the reader's own "open Astera to repair it", still a
   *  `RepairNeeded` naming the file: only the app can repair it, so the command answers CONFLICT
   *  with `repair` (orchDeps). */
  const bypassFromSettings = async (): Promise<boolean> => {
    try {
      return (await readAgentPermissionMode(settingsPath)) === 'yolo'
    } catch (err) {
      log(`spawn refused: ${(err as Error).message}`)
      const why = `the Host will not start a session: ${(err as Error).message}`
      throw err instanceof RepairNeeded ? new RepairNeeded(why, err.file) : new Error(why)
    }
  }

  /** The app's account lookup throws on an id it cannot find (core.accounts.get), and so does this. */
  const accountIn = (accounts: Account[], id: string): Account => {
    const account = accounts.find((x) => x.id === id)
    if (!account) throw new Error(`unknown account: ${id}`)
    return account
  }

  /** The coordinator's spawn adapter: field for field what the app's coordinator adapter hands its
   *  spawnSession, and what that hands core.sessions.spawn. */
  const spawnSession = async (o: SpawnOpts, accounts: Account[], trace?: StartTrace): Promise<{ id: string }> => {
    const account = accountIn(accounts, o.accountId)
    await preTrustWorkspace({ account, cwd: o.cwd, homeDir, descriptors, log })
    await ensured()
    const cliPath = await shuttlePath()
    let bypass = o.bypassPermissions
    if (bypass === undefined) {
      try {
        bypass = await bypassFromSettings()
      } catch (err) {
        // Refused before `sessions.spawn`, so no process (m6). The worker start reads this.
        if (trace) trace.settingsRefused = true
        throw err
      }
    }
    const rollProviders = o.rollAccountIds.map((rid) => providerOf(accounts.find((x) => x.id === rid) ?? account))
    const opensBefore = opens
    let info: ReturnType<SessionManager['spawn']>
    try {
      info = sessions.spawn({
      account,
      cwd: o.cwd,
      bypassPermissions: bypass,
      initialPrompt: o.initialPrompt,
      title: o.title,
      rollAccountIds: o.rollAccountIds,
      rollPrompt: o.rollPrompt,
      resumeSessionId: o.resumeSessionId,
      resumePrompt: o.resumePrompt,
      rollProviders,
      orchEnv: { cliPath, skillsPath: cli.skills, profileDir }
      })
    } finally {
      // Whether it returned or threw, a moved count means a process is running (A36). A throw before
      // the pty (CWD_MISSING, a mixed chain) or the registry's own refusal leaves it where it was.
      if (trace && opens !== opensBefore) trace.opened = true
    }
    // The app registers every codex session with its watcher right after core.sessions.spawn.
    if (providerOf(account) === 'codex') {
      const ptyId = registry.sessionPty(info.id)
      if (ptyId) locateRollout(ptyId, info.id, account, info.cwd, Date.now())
    }
    return info
  }

  const coordinatorFor = (accounts: Account[], trace?: StartTrace): OrchCoordinator =>
    new OrchCoordinator({
      spawnSession: (o) => spawnSession(o, accounts, trace),
      writeToSession: (sid, data) => {
        const p = registry.sessionPty(sid)
        if (p) registry.write(p, data)
      },
      isAlive: (sid) => registry.sessionPty(sid) !== null,
      killSession: (sid) => {
        const p = registry.sessionPty(sid)
        if (p) registry.kill(p)
      },
      // R4: the scanner alone, gated on the provider, as the app's orchIsBusy does.
      isBusy: (sid) => {
        const p = registry.sessionPty(sid)
        const accountId = p ? registry.metaOf(p)?.restore.accountId : undefined
        const account = accounts.find((x) => x.id === accountId)
        if (!account) return null
        return descriptorOf(descriptors, account).busyTitleReliable ? (busyOf.get(sid)?.busy ?? false) : null
      },
      // R4: the fork itself is the Host's own worktree registry's — same folder, same registry entry,
      // whichever of `--worktree new` or a Run's own makeRunWorktree asked for it.
      // The trace keeps the folder, so a start whose spawn then fails can remove it again (A36).
      createWorktree: async (a) => {
        const forked = await d.worktrees.fork(a)
        if (trace) trace.forked = forked
        return { path: forked }
      },
      accountProvider: (id) => {
        const a = accounts.find((x) => x.id === id)
        return a ? providerOf(a) : null
      },
      specsDir,
      log
      // No onPromptWrite: the journal is the app's (R9).
    })

  /** The spawns under way, and who is waiting for them to finish (§8.4, R8). A Host that leaves in
   *  the middle of one would kill a worker whose Dispatch the command is about to record as started,
   *  or leave the command half done; one that starts a new spawn while leaving hands a worker to a
   *  registry that is about to kill everything. So `closeAndSettle` refuses new starts and waits for
   *  the ones already taken, which then finish and are recorded, or fail and roll their Dispatch back
   *  as any failed start does. */
  let retiring = false
  let spawnsInFlight = 0
  const settled = new Set<() => void>()
  const spawning = <A extends unknown[], R>(start: (...a: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      // Refused before anything is touched, so tagged: a keyed call keeps no receipt over it (A36).
      if (retiring) throw refusedBeforeActing(new HostRetiring())
      spawnsInFlight += 1
      try {
        return await start(...args)
      } finally {
        spawnsInFlight -= 1
        if (spawnsInFlight === 0) for (const done of [...settled]) done()
      }
    }

  /** The worker start itself: the app's own start path (startWorkerWithChain), over this Host's
   *  accounts and coordinator, with `trace` watching what it does. */
  const startWorkerIn = async (
    a: Parameters<HostLocal['startWorker']>[0],
    trace: StartTrace
  ): Promise<Awaited<ReturnType<HostLocal['startWorker']>>> => {
    const accounts = await readAccounts(accountsPath)
    const started = await startWorkerWithChain(
      {
        getState: d.getState,
        accounts: async () => accounts,
        loginStatus: async (id) => {
          const x = accounts.find((y) => y.id === id)
          return x ? descriptorOf(descriptors, x).isLoggedIn(x.configDir) : false
        },
        coordinator: coordinatorFor(accounts, trace),
        tails,
        log
      },
      a
    )
    startedOn.set(a.dispatchId, started.sessionId)
    return started
  }

  /** Removes the fresh fork of a worker start that failed (A36). True only when the folder is gone.
   *  Never throws: the start's own failure is what the command answers, and this is only cleanup. */
  const discardFork = async (forked: string): Promise<boolean> => {
    try {
      const { failed } = await d.worktrees.removeWorktrees([forked])
      if (failed.length === 0) {
        log(`worker-start: the spawn failed, so removed the fresh worktree ${forked}`)
        return true
      }
      log(`worker-start: the fresh worktree ${forked} of a failed spawn is still in use — left in place`)
    } catch (err) {
      log(`worker-start: the fresh worktree ${forked} of a failed spawn could not be removed — left in place: ${String(err)}`)
    }
    return false
  }

  return {
    inFlight: () => spawnsInFlight,
    closeAndSettle: (ms) => {
      retiring = true
      if (spawnsInFlight === 0) return Promise.resolve()
      log(`retiring — waiting up to ${ms}ms for ${spawnsInFlight} spawn(s) in flight`)
      return new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(bound)
          settled.delete(done)
          resolve()
        }
        // A timer callback runs outside every caller's try/catch, and a throw from it would end the
        // Host with every pty it holds; so it is caught and logged here, and the wait still ends.
        const bound = setTimeout(() => {
          try {
            log(`retiring — ${spawnsInFlight} spawn(s) still in flight after ${ms}ms; leaving without them`)
          } catch {
            /* the log is the only thing that can throw here, and the wait must end regardless */
          }
          done()
        }, ms)
        settled.add(done)
      })
    },
    startWorker: spawning(async (a) => {
      const trace: StartTrace = { opened: false, forked: null, settingsRefused: false }
      try {
        return await startWorkerIn(a, trace)
      } catch (err) {
        // **A fork nothing will ever target is removed** (A36, the risk-6 pattern). worker-start
        // rolls its Dispatch back on this throw, so no state names the folder, and `run-delete
        // --remove-worktrees` would never reach it. Best effort and logged, and the error thrown is
        // this one whatever the removal does. Only when the folder is gone and no process was
        // started is the error tagged as having left nothing, which withdraws the call's mark.
        if (trace.forked !== null && !trace.opened && (await discardFork(trace.forked)) && err instanceof Error)
          throw undoneBeforeFailing(err)
        // **With no fork, a settings refusal left nothing either** (follow-up round m6): it comes
        // before `sessions.spawn`, so no process was started, the same refusal a coordinator's start
        // is tagged for. A `--terminal` reuse never reaches the spawn, so it can never land here, and
        // it types into a live session, which is not nothing. A fork still on disk is something left,
        // so that case stays untagged (the branch above did not throw).
        if (trace.forked === null && !trace.opened && trace.settingsRefused && err instanceof Error)
          throw refusedBeforeActing(err)
        throw err
      }
    }),
    startCoordinator: spawning(async (a) => {
      const trace: StartTrace = { opened: false, forked: null, settingsRefused: false }
      try {
        const accounts = await readAccounts(accountsPath)
        // The app makes this folder at boot; the Host may be the first to write into it.
        await fs.mkdir(specsDir, { recursive: true })
        return await startCoordinatorSession(
          {
            specsDir,
            preTrust: async (accountId, cwd) =>
              preTrustWorkspace({ account: accountIn(accounts, accountId), cwd, homeDir, descriptors, log }),
            bypassPermissions: bypassFromSettings,
            spawn: (o) => spawnSession(o, accounts, trace),
            log
          },
          a
        )
      } catch (err) {
        // **No process, no effect** (A36): a settings refusal, an unknown account, or a spawn the
        // registry refused all come here before any pty opened, and are tagged so a keyed run-start
        // keeps no receipt over them. The brief file may already be written; a retry writes it
        // again, and the boot sweep removes it. A failure after the pty opened is not tagged: that
        // coordinator is running, and the call is marked as having acted.
        throw !trace.opened && err instanceof Error ? refusedBeforeActing(err) : err
      }
    }),
    releaseWorker: async ({ dispatchId }) => {
      const args = releaseArgsFor(d.getState().dispatches, dispatchId)
      if (!args) {
        log(`worker-release: unknown dispatch ${dispatchId} — there is no session to close`)
        return
      }
      await coordinatorFor([]).releaseWorker(args)
    },
    readWorker: async ({ dispatchId, limit }) =>
      d.getState().dispatches.some((x) => x.id === dispatchId)
        ? tails.read(dispatchId, limit)
        : `(unknown dispatch: ${dispatchId})`,
    probeLimit: async (disp) => {
      const accounts = await readAccounts(accountsPath)
      return makeLimitProbe({
        statusLinePayload: (sid) => statusLine.read(sid),
        configDirOf: (id) => accounts.find((x) => x.id === id)?.configDir ?? null,
        log
      })(disp)
    },
    // The app's body: a missing file is null, any other failure throws for the server to call malformed.
    readReviewFile: async (specPath) => {
      try {
        return await fs.readFile(specPath, 'utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw e
      }
    },
    // R4/§3.1: the same three names, the same registry `createWorktree` above forks into.
    makeRunWorktree: (a) => d.worktrees.makeRunWorktree(a),
    mergeWorktrees: (runCwd, paths) => d.worktrees.mergeWorktrees(runCwd, paths),
    removeWorktrees: (paths) => d.worktrees.removeWorktrees(paths),
    owns: (name, args) => {
      const a = (args[0] ?? {}) as { terminal?: string; worktree?: string; dispatchId?: string }
      // R4: worktree work is the Host's unless an attached app still does it itself.
      const worktreesOurs = !d.appKeepsWorktrees()
      if (name === 'startWorker') return a.terminal ? held(a.terminal) : a.worktree !== 'new' || worktreesOurs
      if (name === 'makeRunWorktree' || name === 'mergeWorktrees' || name === 'removeWorktrees') return worktreesOurs
      if (name === 'releaseWorker') {
        const r = releaseArgsFor(d.getState().dispatches, a.dispatchId ?? '')
        // Unknown, retained, reused by a later Dispatch, or still pending: nothing is killed on either
        // side, so the Host answers (and logs, as the app does).
        if (!r || r.retained || !r.isLatestOwner || r.sessionId.startsWith('pending:')) return true
        return held(r.sessionId)
      }
      if (name === 'readWorker') {
        const id = a.dispatchId ?? ''
        const disp = d.getState().dispatches.find((x) => x.id === id)
        if (!disp) return true // answered "(unknown dispatch …)"
        if (!tails.has(id)) return false
        // Review I1: once a roll has moved the Dispatch to another session, the app holds the tail
        // that followed it. A `pending:` id is the window before worker-start records the session.
        return disp.sessionId === startedOn.get(id) || disp.sessionId.startsWith('pending:')
      }
      return true
    },
    trackedSessions: () => sessions.list().length
  }
}

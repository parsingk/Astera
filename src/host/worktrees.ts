// The Host's Job worktrees (host S3, §3.1, §3.3, §3.4): it forks, merges and removes them over its
// own registry on the profile's worktrees.json, says whether a folder is in use from what it spawned,
// announces each merge with `git-op`, pushes the file after each change (`worktrees-state`), and
// answers the app's four `worktree-*` calls (R1).
//
// **What is the Host's here and what stays the app's.** This covers the three `OrchServerDeps`
// (`makeRunWorktree`, `mergeWorktrees`, `removeWorktrees`) and the fork behind `--worktree new`. The
// app's scheduler keeps its own forks, integration merges and child-run reaps until S4 (R6); they
// reach this Host only as registry writes through `worktree-*`.
//
// **The git and the rules are integrateGit.ts's, not a second copy.** Every check, command and
// rollback of a fork, a merge and a reap runs there; this file supplies only what differs in the
// Host: where the log goes, who hears a merge, and which sessions a reap may close.
//
// Imports only core modules and node builtins: this bundles into the Host, which runs on a plain
// node.exe that cannot read inside app.asar. The one file it reads is in the profile, and git is
// whatever is on PATH (R12 says once whether it runs).

import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { AppUnreachable, refusedBeforeActing, type OrchCaller } from '../core/host/orchProtocol'
import { liveAppPid } from '../core/host/pidFile'
import { HOST_ACT_PATH_IN_USE, type HostMessage, type PtyMeta, type WorktreesSnapshot } from '../core/host/protocol'
import type { OrchServerDeps } from '../core/orchestration/command'
import type { OrchState } from '../core/orchestration/state'
import {
  forkWorktree,
  integrateWorktrees,
  reapWorktree,
  worktreeDeps,
  type ReapContext
} from '../core/orchestration/exec/integrateGit'
import { WorktreeRegistry, defaultWorktreeRoot, isRegistryFile } from '../core/worktrees/registry'
import { git as realGit } from '../core/worktrees/git'
import { isPathWithin, isSamePath } from '../core/files/tree'
import { RepairNeeded } from '../core/settings/repairNeeded'
import type { WorktreeInfo } from '../core/types'
import type { PtyRegistry } from './registry'
import type { ProcRegistry } from './procRegistry'
import type { HostServer } from './server'

export const WORKTREE_CALLS: ReadonlySet<string> = new Set(['worktree-list', 'worktree-add', 'worktree-remove', 'worktree-root'])

export interface HostWorktreesDeps {
  profileDir: string
  homeDir: string
  ptys: Pick<PtyRegistry, 'liveEntries' | 'kill'>
  procs: Pick<ProcRegistry, 'liveEntries'>
  getState(): OrchState
  broadcast(m: HostMessage): void
  log(m: string): void
  /** The attached app, asked before a folder is removed about what it runs itself (the ruling on
   *  plan risk 3, HOST_ACT_PATH_IN_USE). */
  app: Pick<HostServer, 'hasApp' | 'act'>
  /** Test seams; the wiring leaves them out. */
  closeTimeoutMs?: number
  pollMs?: number
  git?: typeof realGit
}

export interface HostWorktrees {
  /** Once, at Host start: the one read that may heal a damaged file (R10). */
  load(): Promise<void>
  /** OrchCoordinator's createWorktree and makeRunWorktree's body: forkWorktree over the Host's registry. */
  fork(a: { repoPath: string; name?: string }): Promise<string>
  makeRunWorktree: NonNullable<OrchServerDeps['makeRunWorktree']>
  mergeWorktrees: NonNullable<OrchServerDeps['mergeWorktrees']>
  removeWorktrees: NonNullable<OrchServerDeps['removeWorktrees']>
  /** R8, the app's tags. */
  isPathInUse(p: string): string | null
  /** The four internal orch-calls, app only (R1). */
  call(cmd: string, args: Record<string, unknown>, from: OrchCaller | undefined): Promise<{ status: number; body: unknown }>
}

type Live = { id: string; cwd: string; meta: PtyMeta | null }

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createHostWorktrees(d: HostWorktreesDeps): HostWorktrees {
  const registry = new WorktreeRegistry(path.join(d.profileDir, 'worktrees.json'), defaultWorktreeRoot(d.homeDir), d.log)

  /** One counter per Host life, bumped on every registry change whether or not its push got out
   *  (WorktreesSnapshot's contract). */
  let seq = 0
  const snapshot = (): WorktreesSnapshot => ({ seq, file: registry.file() })
  /** A broadcast from inside a git operation or a registry listener: a throw is logged and goes no
   *  further (constraint 12), so a socket that went away costs neither the merge nor the write. */
  const tell = (m: HostMessage): void => {
    try {
      d.broadcast(m)
    } catch (err) {
      d.log(`${m.t} could not be sent: ${message(err)}`)
    }
  }
  registry.onChange((file) => {
    seq++
    tell({ t: 'worktrees-state', seq, file })
  })

  // R12: the first worktree operation of this Host's life says whether git runs at all. A packaged
  // Host with no git on PATH would otherwise read every repository as unreachable, silently.
  let gitChecked: Promise<void> | null = null
  const checkGit = (): Promise<void> =>
    (gitChecked ??= (d.git ?? realGit)(['--version']).then(
      (r) => d.log(r.ok ? `git: ${r.stdout}` : `git: cannot run git (${r.stderr || r.stdout || 'no output'})`),
      (err: unknown) => d.log(`git: cannot run git (${message(err)})`)
    ))

  /** The start of every operation that reads or writes the registry: the file as it is now (R2),
   *  so an entry the app wrote in its local mode is seen. **Never load()**: load heals a damaged file by writing an empty list, which
   *  is right once at a process start and wrong in the middle of a life (Task 1 N1). A damaged file
   *  refuses here as `RepairNeeded`, and file and memory stay as they were.
   *
   *  Tagged `refusedBeforeActing` (fix round 1, I2): every caller reaches this before it has closed,
   *  removed or created anything, so a `RepairNeeded` from here means nothing happened yet. */
  const fresh = async (): Promise<void> => {
    await checkGit()
    try {
      await registry.refresh()
    } catch (err) {
      throw refusedBeforeActing(err as Error)
    }
  }

  // ---- in use (R8) ----
  //
  // **Not the app's rule, deliberately.** The app asks whether a running session's cwd, or a run's
  // project path, is in or below the folder. The Host has no project paths; it has the folder each
  // live pty and line process was spawned in, whatever its kind. So here a run counts by its spawn
  // folder (a run configuration whose working directory is outside its project is in use in the app
  // and not here, and the reverse), and a shell tab opened in the folder counts (it does not in the
  // app). Of the two directions this is the safe one for a removal: anything the Host spawned in or
  // below the folder and that is still alive keeps it. What neither side sees is a shell that `cd`s
  // into the folder after it started; what only the app sees is asked of the app before a removal
  // (`askApp`).
  //
  // An entry whose cwd is not a string (a client that left it out of `pty-spawn`; the wire is not
  // checked) was started in the Host's own working directory, which is not a worktree Astera made,
  // and is skipped rather than allowed to throw: the reap's callers rely on it never throwing.
  const liveIn = (p: string, e: Live): boolean => typeof e.cwd === 'string' && isPathWithin(p, e.cwd)
  const tagOf = (e: Live): string => {
    const r = e.meta?.restore ?? {}
    if (e.meta?.kind === 'run') return `RUN:${typeof r.configName === 'string' ? r.configName : e.meta.id}`
    if (e.meta) return `SESSION:${typeof r.title === 'string' ? r.title : e.meta.id}`
    return `SESSION:${e.id}`
  }
  const isPathInUse = (p: string): string | null => {
    try {
      for (const e of [...d.ptys.liveEntries(), ...d.procs.liveEntries()]) if (liveIn(p, e)) return tagOf(e)
      return null
    } catch (err) {
      // A folder whose use cannot be read is in use: the answer that keeps it.
      d.log(`could not tell whether ${p} is in use: ${message(err)}`)
      return 'UNKNOWN'
    }
  }

  // ---- the reap (rule 11, R9) ----
  const sessionsIn = (p: string): Live[] => {
    try {
      return d.ptys.liveEntries().filter((e) => e.meta?.kind === 'session' && liveIn(p, e))
    } catch (err) {
      d.log(`could not list the sessions in ${p}: ${message(err)}`)
      return []
    }
  }
  const sessions: ReapContext['sessions'] = {
    // The session id, as a Dispatch holds it (`sessionId`), not the pty id.
    inTree: (p) => sessionsIn(p).map((e) => ({ id: e.meta?.id ?? e.id })),
    // Every live pty of that session, wherever it runs: a roll can leave an old one alive a while.
    kill: (sessionId) => {
      let live: Live[] = []
      try {
        live = d.ptys.liveEntries().filter((e) => e.meta?.kind === 'session' && e.meta.id === sessionId)
      } catch (err) {
        d.log(`could not find the ptys of session ${sessionId}: ${message(err)}`)
      }
      for (const e of live) {
        try {
          d.ptys.kill(e.id)
        } catch (err) {
          // ConPTY's kill can throw (registry.ts killAll); the poll below then waits it out and the
          // removal refuses on IN_USE, which is the right end.
          d.log(`could not close pty ${e.id} of session ${sessionId}: ${message(err)}`)
        }
      }
    },
    // Only sessions, the ones this reap closed: a run or a shell there is `isPathInUse`'s to refuse.
    anyRunningIn: (p) => sessionsIn(p).length > 0
  }

  /** An app that is alive and not attached: one that gave up on this Host while its event loop
   *  stalled (it then runs new sessions on local node-pty and does not reconnect), or one that has not
   *  reconnected since a Host restart. Those sessions are invisible here, so no folder is removed
   *  while such an app runs (review I1). Known from the pid file the app keeps in the profile
   *  (core/host/pidFile.ts, which says what its pid-reuse residual costs). */
  const DETACHED_APP =
    'Astera is running but not connected to this Host; remove the worktree from the app, or quit Astera and retry'
  const detachedApp = (): boolean => !d.app.hasApp() && liveAppPid(d.profileDir) !== null

  /** Whether an app runs something in the folder the Host cannot see, as a reason, or null.
   *  - Attached (the ruling on plan risk 3): the app is asked, and one that does not answer, or
   *    answers what cannot be read, keeps the folder.
   *  - Alive and not attached: kept, see DETACHED_APP.
   *  - No app alive: nothing the Host cannot see. */
  const askApp = async (p: string): Promise<string | null> => {
    // A throw here is caught by whoever asked: `reap` and reapWorktree's own try both keep the folder.
    if (!d.app.hasApp()) return liveAppPid(d.profileDir) !== null ? DETACHED_APP : null
    try {
      const answer = await d.app.act(HOST_ACT_PATH_IN_USE, [p])
      if (answer === null || typeof answer === 'string') return answer
      return `an answer the Host cannot read (${JSON.stringify(answer)})`
    } catch (err) {
      return `no answer from the app (${message(err)})`
    }
  }

  /** Rule 11 over the Host's own sessions. **Never throws** (review M8): integrateWorktrees' reap and
   *  worktreeDeps' removal rely on it, and a throw there would turn a finished merge into a failure. */
  const reap = async (p: string): Promise<boolean> => {
    try {
      const appUse = await askApp(p)
      if (appUse !== null) {
        d.log(`worktree ${p} is in use in the app (${appUse}) — left alone`)
        return false
      }
      // The held check reads the Host's own Dispatches (retained, outcome, endedAt), read here so a
      // state that cannot be read keeps the worktree.
      let dispatches: OrchState['dispatches']
      try {
        dispatches = d.getState().dispatches
      } catch (err) {
        d.log(`worktree ${p} left alone: the Dispatches could not be read (${message(err)})`)
        return false
      }
      return await reapWorktree(p, {
        registry,
        sessions,
        dispatches: () => dispatches,
        isPathInUse,
        // Asked again at the removal itself: the first answer is up to the close timeout old by then,
        // and the app may have attached or left in between.
        beforeRemove: askApp,
        log: d.log,
        closeTimeoutMs: d.closeTimeoutMs,
        pollMs: d.pollMs
      })
    } catch (err) {
      d.log(`worktree ${p} left alone: ${message(err)}`)
      return false
    }
  }

  // ---- git-op (R7, §3.3) ----
  // The `end` message names the folder its `begin` did; integrateGit hands `end` only the op.
  const opCwd = new Map<string, string>()
  const gitOp = {
    begin: (kind: 'job-merge', cwd: string): string => {
      const op = randomUUID()
      tell({ t: 'git-op', op, phase: 'begin', kind, cwd })
      opCwd.set(op, cwd)
      return op
    },
    end: (op: string): void => {
      const cwd = opCwd.get(op) ?? ''
      opCwd.delete(op)
      tell({ t: 'git-op', op, phase: 'end', kind: 'job-merge', cwd })
    }
  }

  const deps = worktreeDeps({
    integrate: (into, paths, opts) => integrateWorktrees(into, paths, opts, { log: d.log, gitOp, reap, git: d.git }),
    reap,
    log: d.log
  })

  const fork = async (a: { repoPath: string; name?: string }): Promise<string> => {
    await fresh()
    return forkWorktree(a, { registry, log: d.log })
  }

  // ---- the app's writes (R1) ----
  const withFile = (): { status: number; body: unknown } => ({ status: 200, body: snapshot() })
  const calls: Record<string, (args: Record<string, unknown>) => Promise<{ status: number; body: unknown }>> = {
    'worktree-list': async () => withFile(),
    'worktree-add': async (args) => {
      if (!isRegistryFile({ items: [args.info] })) return { status: 400, body: { error: 'worktree-add needs a whole worktree entry' } }
      const info = args.info as WorktreeInfo
      // An add retried after its reply was lost (review M12) carries the same id the app already
      // made: nothing changes, so nothing is pushed. Matching by id rather than by path (review N2,
      // m6) is what tells the two apart from a genuine re-create that reuses a stale entry's path —
      // createWorktree checks only disk and branch, not the registry, so it can hand out a fresh id
      // at a path some earlier entry still names (M10: the folder is gone but the entry is not).
      // That entry is stale, not a duplicate, so it is replaced rather than left to shadow the new
      // one: removeEntry and add are each queued in order on the same registry, so the add always
      // reads a file the removal has already left.
      if (!registry.get(info.id)) {
        const stale = registry.list().find((w) => isSamePath(w.path, info.path))
        if (stale) await registry.removeEntry(stale.id)
        await registry.add(info)
      }
      return withFile()
    },
    'worktree-remove': async (args) => {
      if (typeof args.id !== 'string') return { status: 400, body: { error: 'worktree-remove needs an id' } }
      await registry.removeEntry(args.id)
      return withFile()
    },
    'worktree-root': async (args) => {
      if (typeof args.root !== 'string' && args.root !== null)
        return { status: 400, body: { error: 'worktree-root needs a root, or null for the default' } }
      await registry.setRoot(args.root)
      return withFile()
    }
  }

  return {
    load: async () => {
      await registry.load()
    },
    fork,
    makeRunWorktree: (a) => fork(a),
    // No re-read: a merge never reads the registry (rule 5 asks git for the branches), so a damaged
    // worktrees.json must not stop one. Only what reads or writes the registry re-reads it.
    mergeWorktrees: async (runCwd, paths) => {
      await checkGit()
      return deps.mergeWorktrees(runCwd, paths)
    },
    removeWorktrees: async (paths) => {
      await fresh()
      // Refused whole, before anything is closed or removed, so the command answers a conflict (exit
      // 6) and `run-delete` deletes nothing, rather than a list of folders that all failed.
      // AppUnreachable because that is what it is: the app that must be asked cannot be. Tagged
      // `refusedBeforeActing` (fix round 1, I2) for the same reason `fresh()`'s is: nothing has been
      // closed or removed yet, so a caller may keep no receipt over this one.
      let detached = false
      try {
        detached = detachedApp()
      } catch {
        /* the per-folder check in `reap` refuses on its own */
      }
      if (detached) throw refusedBeforeActing(new AppUnreachable(DETACHED_APP))
      return deps.removeWorktrees(paths)
    },
    isPathInUse,
    call: async (cmd, args, from) => {
      const handle = calls[cmd]
      if (!handle) return { status: 501, body: { error: `unknown command: ${cmd}` } }
      if (from?.role !== 'app') return { status: 403, body: { error: `${cmd} is the app’s to send` } }
      try {
        await fresh()
        return await handle(args)
      } catch (err) {
        // A file only a restart can heal: a conflict naming it, as the Host answers every other
        // profile file it may not repair (orch.ts `withRepair`), so the CLI offers no command to run.
        if (err instanceof RepairNeeded) return { status: 409, body: { error: err.message, repair: err.file } }
        return { status: 500, body: { error: message(err) } }
      }
    }
  }
}

/** `index.ts`'s wiring, pulled out so it can be tested without booting the real Host: `load()` once
 *  at Host start, and only when the Host spawns anything of its own (R5). With no spawner nothing
 *  built there ever reaches `worktrees` — S2's rule, kept whole in S3 — so nothing here reads the file
 *  either. A failed load is logged, not thrown: the per-operation `fresh()` above still refuses a
 *  damaged file on its own, and a Host that could not heal it at start should still come up and answer
 *  everything that does not touch worktrees.json.
 *
 *  **Awaited by `index.ts`, before it starts listening (fix round 1, M2).** `load()` is the one read
 *  that may heal a damaged file; an operation that reached `fresh()` first would read it still damaged
 *  and answer 409 `repair: worktrees.json` for no reason. The window was already narrow — this load
 *  starts before the address is bound — and awaiting it here closes it for a few milliseconds of start. */
export async function loadWorktreesIfSpawning(a: {
  /** Whether `createHostSpawner` returned a real spawner rather than `null` (R5). */
  hasSpawner: boolean
  worktrees: Pick<HostWorktrees, 'load'>
  log(m: string): void
}): Promise<void> {
  if (!a.hasSpawner) return
  try {
    await a.worktrees.load()
  } catch (err) {
    a.log(`worktrees.json could not be loaded at Host start: ${message(err)}`)
  }
}

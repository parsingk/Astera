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
import type { OrchCaller } from '../core/host/orchProtocol'
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
import { isPathWithin } from '../core/files/tree'
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

  /** The start of every operation: the file as it is now (R2), so an entry the app wrote in its
   *  local mode is seen. **Never load()**: load heals a damaged file by writing an empty list, which
   *  is right once at a process start and wrong in the middle of a life (Task 1 N1). A damaged file
   *  refuses here as `RepairNeeded`, and file and memory stay as they were. */
  const fresh = async (): Promise<void> => {
    await checkGit()
    await registry.refresh()
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

  /** The ruling on plan risk 3: an attached app may run something in the folder that the Host cannot
   *  see, and a removal would delete the folder under it on macOS and Linux. The app is asked; an
   *  app that does not answer, or answers what cannot be read, keeps the folder. With no app
   *  attached there is nothing the Host cannot see. */
  const askApp = async (p: string): Promise<string | null> => {
    if (!d.app.hasApp()) return null
    try {
      const answer = await d.app.act(HOST_ACT_PATH_IN_USE, [p])
      if (answer === null || typeof answer === 'string') return answer
      return `an answer the Host cannot read (${JSON.stringify(answer)})`
    } catch (err) {
      return `no answer from the app (${message(err)})`
    }
  }

  const reap = async (p: string): Promise<boolean> => {
    const appUse = await askApp(p)
    if (appUse !== null) {
      d.log(`worktree ${p} is in use in the app (${appUse}) — left alone`)
      return false
    }
    // The held check reads the Host's own Dispatches (retained, outcome, endedAt). Read here, not
    // inside reapWorktree, so a state that cannot be read keeps the worktree instead of throwing
    // out of a function whose callers rely on it never throwing.
    let dispatches: OrchState['dispatches']
    try {
      dispatches = d.getState().dispatches
    } catch (err) {
      d.log(`worktree ${p} left alone: the Dispatches could not be read (${message(err)})`)
      return false
    }
    return reapWorktree(p, {
      registry,
      sessions,
      dispatches: () => dispatches,
      isPathInUse,
      log: d.log,
      closeTimeoutMs: d.closeTimeoutMs,
      pollMs: d.pollMs
    })
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
      await registry.add(args.info as WorktreeInfo)
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
    mergeWorktrees: async (runCwd, paths) => {
      await fresh()
      return deps.mergeWorktrees(runCwd, paths)
    },
    removeWorktrees: async (paths) => {
      await fresh()
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

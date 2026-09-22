// The Astera Host (design §4). Not an Electron app: it is this repository's third main-process
// bundle, run as plain Node through the app's own binary with ELECTRON_RUN_AS_NODE=1, the way the
// `astera` CLI shuttle already avoids shipping a Node binary.
//
// Everything it needs arrives in the environment, because it has no `app.getPath('userData')` to ask.
import childProcess from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import * as pty from 'node-pty'
import { hostAddress } from './address'
import { nodePtyMissing } from './nodePtyCheck'
import { hostPidFilePath, serializeHostPidFile } from '../core/host/pidFile'
import { hideForkedConsoleWindows } from './childWindows'
import { openHostLog } from './log'
import { startHostServer, ADDRESS_TAKEN } from './server'
import { PtyRegistry } from './registry'
import { attachPtyHost } from './ptyHost'
import { attachProcHost } from './procHost'
import { ProcRegistry } from './procRegistry'
import { nodeProcSpawn } from './nodeProc'
import { HOST_PROTOCOL } from '../core/host/protocol'
import { createHostOrch } from './orch'

/** With no client for this long, there is nothing for the Host to be. Slice 2 adds "and no session is
 *  alive" to this, and slice 3 adds "and no Run is in progress" (design §8). */
const IDLE_MS = 60_000

/** How long the Host lets its own event loop turn after ending its sessions, before calling exit.
 *  Measured on win32: exit() called in the same turn as the kill never returns and never exits — it
 *  blocks inside node-pty's ConPTY teardown, and the pty exit callbacks never even run. One turn is
 *  enough for that teardown to finish, and exit() then works. */
const EXIT_SETTLE_MS = 300
/** The net under that, for a teardown that does not finish. A Host that has closed its address and
 *  ended its sessions has nothing left to do gracefully, and one that will not leave is worse than
 *  one that leaves hard: it holds the address's twin, and it is invisible outside Task Manager. */
const EXIT_HAMMER_MS = 1_500

async function main(): Promise<void> {
  // Before anything can create a child: node-pty forks a helper on every ConPTY kill, and from 1.3.20
  // this process is a console-subsystem node.exe, so that helper would be handed a console window of
  // its own — a black window flashing up whenever a person closes a session tab. See childWindows.ts.
  hideForkedConsoleWindows(childProcess, process.platform)

  const profileDir = process.env.ASTERA_HOST_PROFILE_DIR
  if (!profileDir) {
    process.stderr.write('astera-host: ASTERA_HOST_PROFILE_DIR is required\n')
    process.exit(2)
  }
  const log = openHostLog({ path: process.env.ASTERA_HOST_LOG ?? path.join(profileDir, 'host', 'host.log') })
  const addr = hostAddress({ profileDir, platform: process.platform, tmpDir: os.tmpdir(), protocol: HOST_PROTOCOL })

  // Where node-pty's own JavaScript lives, for the check below. `createRequire(__filename)` rather
  // than `require.resolve` written bare: this file is bundled, and the explicit form is the one no
  // bundler rewrites. Null when it cannot be worked out, which `nodePtyMissing` treats as "do not
  // check" rather than as a failure.
  const ptyLibDir = ((): string | null => {
    try {
      return path.dirname(createRequire(__filename).resolve('node-pty'))
    } catch (err) {
      log.write(`could not locate node-pty to check it: ${String(err)}`)
      return null
    }
  })()

  // The Host is where node-pty lives now. `withExitedPtyGuard`'s job — swallowing a write or resize
  // to a pty that has already gone — is the registry's `live` check here instead: it knows which
  // sessions have exited, and the app across the socket does not.
  const registry = new PtyRegistry({
    spawn: (file, args, opts) => {
      // **Checked here, before every spawn, and not once at startup.** The file can go missing while
      // this Host is running — that is exactly what happened on 2026-09-22 — and the Host would not
      // notice, because it never reads it again until a spawn needs it. Which is the moment it stops
      // being able to tell anyone anything (see nodePtyCheck.ts for the mechanism). Two `existsSync`
      // calls per session is nothing beside what a spawn already costs.
      const missing = nodePtyMissing({ platform: process.platform, libDir: ptyLibDir, exists: existsSync })
      // Thrown rather than returned: `PtyRegistry.open` already catches a spawn that throws and
      // answers `pty-failed` with the message, which is the path this wants — the app shows the
      // sentence on the terminal (ptyFactory.ts) instead of a session that never appears.
      if (missing) throw new Error(`node-pty is incomplete: ${missing} is missing — the app repairs this at the next Host start`)
      return pty.spawn(file, args, { name: 'xterm-256color', ...opts })
    },
    log: (m) => log.write(m)
  })
  let handlePty: ReturnType<typeof attachPtyHost> | null = null

  // The Host's second registry: line processes — a chat session's protocol child (chat-sessions design
  // §6.5). Same lifetime rules as the ptys, none of the terminal parts.
  const procs = new ProcRegistry({
    spawn: nodeProcSpawn({ log: (m) => log.write(m), platform: process.platform }),
    log: (m) => log.write(m)
  })
  let handleProc: ReturnType<typeof attachProcHost> | null = null

  let server: Awaited<ReturnType<typeof startHostServer>>
  /** Every way out goes through here, and it ends the process whatever happened on the way. An earlier
   *  version put `process.exit(0)` after `killAll()` inside a `.then()` that nothing caught, and on
   *  win32 that was not theoretical: node-pty's ConPTY kill runs a helper process to enumerate the
   *  console, the helper fails under ELECTRON_RUN_AS_NODE ("AttachConsole failed"), and the throw
   *  reached the promise. The Host then sat there with its pipe closed and its sessions still running,
   *  and the rejection went nowhere because the promise was only `void`ed. The registry guards each
   *  kill now, and this guards the rest of the path. */
  const leave = (why?: string): void => {
    // The idle and retire paths have already said why in the server's own log line; a signal has not.
    if (why) log.write(`${why} — leaving`)
    // Before the close, so a Host that is on its way out is not offered up as one to end. A failure
    // here costs nothing: the app checks the executable behind the pid before acting on it, and a
    // record this Host left behind names a pid that is about to stop existing.
    try {
      rmSync(hostPidFilePath(profileDir), { force: true })
    } catch {
      /* the app validates what it reads there anyway */
    }
    void server
      .close()
      .catch((err) => log.write(`the server did not close cleanly: ${String(err)}`))
      .finally(() => {
        registry.killAll()
        procs.killAll()
        // Both deferred, and both unref'd: see EXIT_SETTLE_MS. Unref'd so that a Host whose loop
        // empties on its own is not held open by its own way out.
        setTimeout(() => process.exit(0), EXIT_SETTLE_MS).unref()
        setTimeout(() => process.kill(process.pid, 'SIGKILL'), EXIT_HAMMER_MS).unref()
      })
  }

  // Shared with `orch` below so the version the handshake reports and the version `orch-call status`
  // answers never drift apart.
  const hostVersion = process.env.ASTERA_HOST_VERSION ?? '0.0.0'

  // The orchestration state and the commands over it (host control plane design §5, §6).
  //
  // **Constructed, not loaded.** `ready()` is deliberately not called here: the app still builds its
  // own store on this same file and still runs its boot cleanup, and loading here would put a second
  // process's restart recovery on it. The first call that needs the state loads it, and once the app
  // has pushed its state there is nothing left to load — see `createHostOrch`.
  //
  // `server` is assigned a few lines down; every one of these closures runs long after that, because
  // nothing can call them before a client has connected.
  const orch = createHostOrch({
    profileDir,
    version: hostVersion,
    now: () => new Date().toISOString(),
    // The same two registries `liveCounts` counts — this Host's own sessions, which `status` must be
    // able to answer with no app attached.
    runningSessions: () => registry.liveCount() + procs.liveCount(),
    act: (name, args) => server.act(name, args),
    hasApp: () => server.hasApp(),
    // Every commit goes to the clients, so the app can swap its mirror (design §5). Greeted sockets
    // only, which `broadcast` already guarantees.
    onState: (state) => server.broadcast({ t: 'orch-state', state }),
    // The command layer's own `deps.log?.()` calls end up here too (hostOrchDeps) — a limit probe
    // that could not run, an action that could not be forwarded. Otherwise the Host degrades in
    // silence, and a person looking for why nothing happened has nothing to read.
    log: (m) => log.write(m)
  })
  try {
    server = await startHostServer({
      address: addr.address,
      dirToPrepare: addr.dirToPrepare,
      version: hostVersion,
      idleMs: IDLE_MS,
      onIdle: () => leave(),
      onMessage: (m, send) => (handlePty?.(m, send) ?? false) || (handleProc?.(m, send) ?? false),
      holdsWork: () => registry.liveCount() + procs.liveCount() > 0,
      // Jobs are not the Host's to count yet — a later task gives it a Job registry, and this literal
      // 0 is what that task replaces (server.ts's own comment on `liveCounts` says the same).
      liveCounts: () => ({ sessions: registry.liveCount() + procs.liveCount(), jobs: 0 }),
      orch,
      log
    })
  } catch (err) {
    // Losing the bind race is the normal outcome of two apps starting at once, and it is not a
    // failure: the other Host serves them both.
    const taken = err instanceof Error && err.message === ADDRESS_TAKEN
    log.write(taken ? 'another Host already serves this profile — leaving' : `could not listen: ${String(err)}`)
    process.exit(0)
  }

  // Written only once the address is ours: a Host that lost the bind race has nothing to say about
  // who serves this profile, and a record from it would name the wrong process. Never fatal — the
  // file is a convenience for the one case the handshake cannot cover (design F3), and a Host that
  // could not write it still serves every session perfectly well.
  try {
    writeFileSync(
      hostPidFilePath(profileDir),
      serializeHostPidFile({ pid: process.pid, startedAt: server.startedAt, exe: process.execPath })
    )
  } catch (err) {
    log.write(`could not record which process this Host is: ${String(err)}`)
  }

  handlePty = attachPtyHost({ registry, broadcast: (m) => server.broadcast(m) })
  handleProc = attachProcHost({ registry: procs, broadcast: (m) => server.broadcast(m) })

  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => leave(signal))
}

void main()

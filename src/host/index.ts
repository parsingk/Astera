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
import tls from 'node:tls'
import * as pty from 'node-pty'
import { hostAddress } from './address'
import { nodePtyMissing } from './nodePtyCheck'
import { hostPidFilePath, serializeHostPidFile } from '../core/host/pidFile'
import { SPAWN_DEADLINE_MS } from '../core/host/unresponsive'
import { hideForkedConsoleWindows } from './childWindows'
import { trustSystemCa } from './systemCa'
import { openHostLog, logUnhandledRejections } from './log'
import { startHostServer, ADDRESS_TAKEN } from './server'
import { PtyRegistry } from './registry'
import { attachPtyHost } from './ptyHost'
import { attachProcHost } from './procHost'
import { ProcRegistry } from './procRegistry'
import { createProcHolders, procHeldBy } from './procHolders'
import { nodeProcSpawn } from './nodeProc'
import { HOST_PROTOCOL, HOST_YIELD_WORKTREES } from '../core/host/protocol'
import { createHostOrch } from './orch'
import { composeHostDriving } from './drivingWiring'
import { composeHostRolling } from './rollingWiring'
import { hostFeatures } from './features'
import { loadSlackSdk } from './slackSdk'
import { composeHostSlack, type HostSlackWiring } from './slackWiring'
import { createHostSpawner } from './spawner'
import { createHostWorktrees, loadWorktreesIfSpawning } from './worktrees'
import { createHostProjectRoots } from './projectRoots'
import { createHostExits, ptyHeldBy, type HostExits } from './exits'
import { registrySessions } from './sessions'
import { hookEventsDirIn } from '../core/hooks/sessionState'
import { readAccountEntries } from '../core/accounts/accountsFile'

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
  // Final review C1, the belt: a rejection nobody handled is logged and never ends the Host (and every
  // session in it). Each path keeps its own catch; this only keeps a miss from being fatal.
  logUnhandledRejections(process, log)
  // S6-22: the OS certificate store joins Node's default CAs before any HTTPS (the usage lookup), so a
  // TLS-inspecting proxy's root verifies. Never throws; on failure the defaults stay (systemCa.ts).
  trustSystemCa(tls, (m) => log.write(m))
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
  // Which app sockets hold which chat proc (chat takeover, constraint 3): the Host is a chat proc's
  // writer only while no app socket holds it. Fed by the server hooks below; an ended proc drops its holds.
  const procHolders = createProcHolders({ log: (m) => log.write(m) })
  procs.onExit((id) => procHolders.ended(id))

  let server: Awaited<ReturnType<typeof startHostServer>>
  /** Declared here and assigned below `createHostOrch` (S6 final review M3): the rolling wiring's
   *  `exits` getter reads it, and a `const` below that getter would throw in its temporal dead zone if a
   *  chain ever decided before the assignment. Null until then, and null for good without a spawner. */
  let exits: HostExits | null = null
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
    // **The driver stops first** (S4+S5, the review of Task 12): no tick from here on, no commit, load
    // or app coming or going starts a pass, and a pass already under way stops at its next `mayStart`
    // (drivingWiring.ts) — before the spawner's own retiring flag is set below. From here on this Host
    // also starts no validation, review or repair, and the `killAll` below is not read as a failed
    // check: the Task stays validating or reviewing, and the next Host restarts it (a convergence Job)
    // or gates it (otherwise). Never throws.
    wiring?.dispose()
    // **The rolling stops with it** (S6 R16): its tick and the app-gone watch stop, so no takeover starts
    // from here on, and every chain is quieted. No roll waits: `killAll` below ends every session, a roll
    // in flight included, and the spawner refuses new respawns from `closeAndSettle` on. Never throws.
    rollingWiring?.dispose()
    // **The Slack stops with them** (Slack in the Host, Task 5): its socket is closed and its timers
    // stopped before the server stops accepting, so a Host on its way out holds no socket an app taking
    // Slack back would be a second one beside. Never rejects.
    void slackWiring?.dispose()
    // Before the close, so a Host that is on its way out is not offered up as one to end. A failure
    // here costs nothing: the app checks the executable behind the pid before acting on it, and a
    // record this Host left behind names a pid that is about to stop existing.
    try {
      rmSync(hostPidFilePath(profileDir), { force: true })
    } catch {
      /* the app validates what it reads there anyway */
    }
    // No new client from here on, and the ones connected are kept for the settle below: an app that
    // is replacing this Host must reach the new one, not this one (fix round, I3). `server` is unset
    // only if the listen itself failed, and that path exits without coming here.
    server.stopAccepting()
    void (async () => {
      // **The spawns this Host already took finish first** (Host S2 design §8.4, R8), and no new one
      // is taken from here on. Bounded by the app's own spawn deadline: past that, the app has given
      // up on the session anyway. `closeAndSettle` never rejects, and the chain below runs whatever
      // happens here.
      if (spawner) await spawner.closeAndSettle(SPAWN_DEADLINE_MS).catch((err) => log.write(`the spawns in flight could not be waited for: ${String(err)}`))
      await server
        .close()
        .catch((err) => log.write(`the server did not close cleanly: ${String(err)}`))
        .finally(() => {
          registry.killAll()
          procs.killAll()
          // Both deferred, and both unref'd: see EXIT_SETTLE_MS. Unref'd so that a Host whose loop
          // empties on its own is not held open by its own way out. Armed after the settle, so the
          // hammer never lands while a spawn is still being waited for.
          setTimeout(() => process.exit(0), EXIT_SETTLE_MS).unref()
          setTimeout(() => process.kill(process.pid, 'SIGKILL'), EXIT_HAMMER_MS).unref()
        })
    })()
  }

  // Shared with `orch` below so the version the handshake reports and the version `orch-call status`
  // answers never drift apart.
  const hostVersion = process.env.ASTERA_HOST_VERSION ?? '0.0.0'

  // The Host's own worktree registry (Host S3 §3.1, §3.3, §3.4): forks, merges and removes Job
  // worktrees over its own registry, whether or not an app is attached. Construction reads and writes
  // nothing, so building it unconditionally keeps S2's "constructed, not loaded" rule — at start its
  // registry is read only by `loadWorktreesIfSpawning` below, and only when there is a spawner (R5);
  // with no spawner nothing else here ever reaches `worktrees` either, so nothing is read at all.
  //
  // `server` and `orch` are assigned below; its closures only run inside an operation, long after both
  // exist.
  const worktrees = createHostWorktrees({
    profileDir,
    homeDir: os.homedir(),
    ptys: registry,
    procs,
    getState: () => orch.state(),
    broadcast: (m) => server.broadcast(m),
    log: (m) => log.write(m),
    app: { hasApp: () => server.hasApp(), act: (name, args) => server.act(name, args), lastAppPid: () => server.lastAppPid() }
  })

  // The Host's own spawn path (Host S2 design §2.1): orchestration workers and coordinators started in
  // this registry, so a coordinator's worker-start works with no Astera window open. Null when the
  // Host was started without the CLI paths, and then those commands go to the app as before (R1).
  //
  // It writes nothing until its first spawn (R6). `server` and `orch` are assigned below; its
  // closures only run inside a command, long after both exist.
  const spawner = createHostSpawner({
    profileDir,
    env: process.env,
    platform: process.platform,
    homeDir: os.homedir(),
    registry,
    broadcast: (m) => server.broadcast(m),
    getState: () => orch.state(),
    log: (m) => log.write(m),
    worktrees,
    // R4: an app old enough to have no S3 worktree module of its own still keeps doing this work
    // itself, and says so in its `hello.yields` (HOST_YIELD_WORKTREES).
    appKeepsWorktrees: () => server.appKeeps(HOST_YIELD_WORKTREES)
  })

  // R10: the one read that may heal a damaged worktrees.json, done once — and only when the Host
  // spawns anything of its own (R5). With no spawner nothing built above ever reaches `worktrees`, so
  // nothing is read here either, which is S2's rule kept whole in S3. Awaited (fix round 1, M2): an
  // operation that reached the registry before this heal finished would read it still damaged.
  await loadWorktreesIfSpawning({ hasSpawner: spawner !== null, worktrees, log: (m) => log.write(m) })

  // The Slack SDK (Slack in the Host, P1): loaded once, with import(), before the server fixes its
  // features, and **only with a spawner** (`slack-owner` rides `spawn`). A failed load is logged by its
  // error name and this Host announces no `slack-owner`, so the app keeps Slack. Nothing else reads it
  // yet: the Host's Slack composition is built below the rolling.
  const slackSdk = spawner ? await loadSlackSdk({ env: process.env, log: (m) => log.write(m) }) : null

  // **The Host drives Jobs** (S4+S5 §4, §5.1): its own checks, the dispatch loop and its triggers, and
  // the hooks they hand `createHostOrch` and `startHostServer` — one composition, which the integration
  // rig builds too (N11). **Only with a spawner** (R7): a Host that cannot start a worker cannot place
  // one, and one that announced `dispatch` anyway would stop the app's own loop in front of a Host that
  // places nothing. `orch` and `server` are assigned below; every closure here runs long after both.
  const wiring = spawner
    ? composeHostDriving({
        profileDir,
        platform: process.platform,
        env: process.env,
        registry,
        spawner,
        worktrees,
        orch: () => orch,
        server: () => server,
        log: (m) => log.write(m),
        now: () => new Date().toISOString(),
        nowMs: () => Date.now()
      })
    : null

  /** Declared above the rolling (the S6 final review M3 lesson): Task 6 has the rolling's events reach it,
   *  and a `const` below would be in its temporal dead zone. Null without a spawner or without the SDK. */
  let slackWiring: HostSlackWiring | null = null

  // **The Host rolls its sessions** (S6 §2, §3A): the two coordinators over this registry, the roll tap, and
  // the takeover of a gone app's sessions — one composition, which the S6 rig builds too. **Only with a
  // spawner** (R17): a roll's respawn is the spawner's, and `rolling` is announced with `spawn` or not at
  // all. `orch`, `server` and `exits` are assigned below; building reads none of them (preflight B2).
  const rollingWiring =
    spawner && wiring
      ? composeHostRolling({
          profileDir,
          platform: process.platform,
          registry,
          procs,
          procHolders,
          version: hostVersion,
          spawner,
          // No exits yet means no app has attached, so no app holds any pty: the holders are empty.
          exits: () => exits ?? { holdersOf: () => [] },
          server: () => server,
          orch: () => orch,
          lang: () => wiring.checks.langNow(),
          log: (m) => log.write(m),
          nowIso: () => new Date().toISOString(),
          // Slack in the Host Task 6: the Host's own rolls and every hook event are its Slack's sources.
          // Read at the call: the Slack composition is built below, and each tap isolates itself.
          onRollEvent: (e) => slackWiring?.onRollEvent(e),
          hookTap: (sid, p) => slackWiring?.onHookEvent(sid, p)
        })
      : null

  // **The Host's Slack** (Slack in the Host, spec §3): slack.json read only, one notifier, one inbox, and
  // the socket held only while no attached app keeps Slack (P4). **Only with a spawner and the SDK**:
  // `slack-owner` is announced on the same two facts, and a Host without it answers slack-reload 501.
  // Nothing is opened until `start()` below, once the server exists. The accounts come from the rolling's
  // own snapshot, and its chats and chains are what the Host sources itself (Task 6).
  slackWiring =
    spawner && wiring && rollingWiring && slackSdk
      ? composeHostSlack({
          profileDir,
          sdk: slackSdk,
          registry,
          procs,
          statusLinePayload: (id) => spawner.statusLinePayload(id),
          chats: rollingWiring.chats,
          rolling: rollingWiring.rolling,
          server: () => server,
          lang: () => wiring.checks.langNow()
        })
      : null

  // The orchestration state and the commands over it (host control plane design §5, §6).
  //
  // **Constructed, not loaded.** `ready()` is deliberately not called here: the app still builds its
  // own store on this same file and still runs its boot cleanup, and loading here would put a second
  // process's restart recovery on it. The first call that needs the state loads it, and once the app
  // has pushed its state there is nothing left to load — see `createHostOrch`. That is still true now
  // that the Host can start sessions itself: a spawn happens only inside a command, and every command
  // waits on `ready()` first.
  //
  // `server` is assigned a few lines down; every one of these closures runs long after that, because
  // nothing can call them before a client has connected.
  const orch = createHostOrch({
    profileDir,
    version: hostVersion,
    now: () => new Date().toISOString(),
    // The handshake's own string, not a second one taken here: `requests show` answers with it so a
    // caller can tell "this Host never saw my request" from "it never arrived" (request receipts
    // design §6), and the value the caller compares it against is the one its `hello` gave it.
    hostStartedAt: () => server.startedAt,
    // The same two registries `liveCounts` counts — this Host's own sessions, which `status` must be
    // able to answer with no app attached.
    runningSessions: () => registry.liveCount() + procs.liveCount(),
    // What the restart cleanup inside `store.load` is judged against — the evidence the app used to
    // have to ask this Host for and could be told nothing about (design §6). A worker session is a
    // pty, so only `registry` is read: a line process is a chat session, and no `Dispatch.sessionId`
    // ever names one. `meta.id` is the app's own id for the session, which is what a Dispatch holds.
    aliveSessionIds: () =>
      new Set(registry.list().filter((e) => e.alive && e.meta?.kind === 'session').map((e) => e.meta!.id)),
    act: (name, args) => server.act(name, args),
    hasApp: () => server.hasApp(),
    // Every commit goes to the clients, so the app can swap its mirror (design §5). Greeted sockets
    // only, which `broadcast` already guarantees.
    onState: (state, version) => server.broadcast({ t: 'orch-state', state, version }),
    // The command layer's own `deps.log?.()` calls end up here too (hostOrchDeps) — a limit probe
    // that could not run, an action that could not be forwarded. Otherwise the Host degrades in
    // silence, and a person looking for why nothing happened has nothing to read.
    log: (m) => log.write(m),
    // `astera sessions` — answered from the same two registries, by the app's id for each session,
    // plus the hook event files the sessions' own hooks append under this profile (read only), and
    // the profile's accounts.json for where a Claude chat session's transcript lives (read only).
    sessions: registrySessions({
      ptys: registry,
      procs,
      hookEventsDir: hookEventsDirIn(profileDir),
      accounts: () => readAccountEntries(path.join(profileDir, 'accounts.json'))
    }),
    local: spawner,
    // The spec sweep goes with the spawner (§2.7): a Host that spawns writes specs and announces
    // `spawn`, and the app then leaves the sweep to this load. One that does not leaves it to the app.
    specsDir: spawner ? path.join(profileDir, 'orch', 'specs') : undefined,
    // The four `worktree-*` orch-calls (R1, R5): only with a spawner, so a Host too old — or too
    // unconfigured — to own worktrees.json answers them 501 rather than ever reaching `worktrees`.
    worktrees: spawner ? worktrees : undefined,
    // The driver's hooks (drive, onCommit, mayDrain, onLoaded, driverStatus, validationStop): absent with
    // no spawner, and then validation, review and repair take their pre-S5 routes to the app.
    // `resolveProjectRoot` with no app attached, or while this Host drives (orchDeps' HOST_RESOLVES): the
    // app's rule over this Host's worktree registry and the profile's accounts' transcripts, read
    // only. With no spawner the registry is never loaded, so its list is empty and the transcripts
    // alone answer.
    resolveProjectRoot: createHostProjectRoots({ profileDir, repoPaths: () => worktrees.repoPaths() }).resolve,
    ...(wiring?.orchHooks ?? {}),
    // The rolling's hooks (rolling, rolledInto, rekeyRolled): absent with no spawner, and then
    // `unregisterRolling` only forwards to the app and a rolled-from exit closes as before.
    ...(rollingWiring?.orchHooks ?? {}),
    // `slack-reload` (P17): absent without the Host's Slack, and the call then answers 501.
    slack: slackWiring ?? undefined
  })

  // Exits of the sessions no app holds (Host S2 design §2.6, R2): closing their Dispatches and
  // emptying their coordinator slots, and the handover sweep when an app leaves. **Only with a
  // spawner**, because the feature and the duty are one fact: without one the Host starts no session
  // of its own, every agent session was the app's, and the app handles its exits as it always has.
  exits = spawner
    ? createHostExits({
        registry,
        sessionExited: (e) => orch.sessionExited(e),
        orphanedSessions: (isAlive) => orch.orphanedSessions(isAlive),
        log: (m) => log.write(m)
      })
    : null
  try {
    server = await startHostServer({
      address: addr.address,
      dirToPrepare: addr.dirToPrepare,
      version: hostVersion,
      idleMs: IDLE_MS,
      onIdle: () => leave(),
      onMessage: (m, send, from) => {
        // Before the pty handler, so the mark is in place before a spawn can exit. Any role: see
        // `ptyHeldBy` for the apps that declare none. Only a greeted socket, which close releases.
        const held = ptyHeldBy(m, from)
        if (exits && held !== null) exits.heldBy(held, from.socket)
        // The chat twin (chat takeover Task 5): a greeted socket's proc-spawn or proc-attach makes it the
        // proc's writer, before the proc handler can answer.
        const heldProc = procHeldBy(m, from)
        if (heldProc !== null) procHolders.heldBy(heldProc, from.socket)
        // S6 D4: an app's block records, absorbed into the rolling's registry and never broadcast back.
        // Only from a greeted app (a CLI has no registry to share), and only when this Host rolls: one
        // without `rolling` never announced `blocks`, so no app sends it, and the line stays unknown.
        if (m.t === 'blocks' && rollingWiring) {
          if (from.greeted && from.role === 'app') rollingWiring.blocksFromApp(m)
          return true
        }
        // Slack in the Host (spec §3.3, P17): what only an app sees, told to the Host that owns Slack. Only
        // from a greeted app; the Host drops what it sources itself.
        if (m.t === 'slack-event') {
          if (slackWiring && from.greeted && from.role === 'app') slackWiring.forwarded(m.event)
          return true
        }
        return (handlePty?.(m, send) ?? false) || (handleProc?.(m, send) ?? false)
      },
      // Released by the socket number whatever role the socket gave last: a second `hello` can change
      // it, and marks made as an app must still go when that socket closes. A socket that never held a
      // pty, which is every CLI call, runs no sweep (exits.ts).
      onClientGone: (from) => {
        exits?.appGone(from.socket)
        procHolders.appGone(from.socket)
      },
      // **Both halves are real now** (ruling F57). The Host owns the state, so it can answer the
      // question `docs/cli.md` already promises `astera host stop` answers: how many Runs have work
      // in flight. The rule is `runningRunCount`'s, which is the sidebar's rule over the state rather
      // than a second one — a Host that let you stop a Run the screen calls running would be the
      // worse half of two answers. The idle timer asks the same question (server.ts), so a Host
      // `astera host start` started stays while a run is in flight, and still leaves holding nothing.
      liveCounts: () => ({
        sessions: registry.liveCount() + procs.liveCount(),
        runs: orch.runningRuns()
      }),
      orch,
      // Announced only when there is a spawner, so an app can tell a Host that starts sessions itself,
      // that it also owns worktrees.json (R5: the one decision is `spawner !== null`), that it drives
      // Jobs (R7) and that it rolls its sessions (R17) — the same one fact.
      features: hostFeatures({ spawns: spawner !== null, slack: slackSdk !== null }),
      // An app's hello and its socket's close (N1). The server isolates the call too (`tellAppsChanged`).
      ...(wiring?.serverHooks ?? {}),
      // Both hear it: the driver's app-left rule and the rolling's app-gone watch. Each isolates itself.
      onAppsChanged: () => {
        wiring?.serverHooks.onAppsChanged()
        rollingWiring?.onAppsChanged()
        // P4: an app that keeps Slack attaching closes the Host's socket; the last one leaving opens it.
        slackWiring?.onAppsChanged()
      },
      // S6 D4: a newly greeted app gets the Host's whole block registry once, after its hello. Limits L3:
      // and who drives, so its Jobs sidebar can say why a parked Host starts nothing. Each isolates itself.
      onAppGreeted: (send) => {
        rollingWiring?.appGreeted(send)
        wiring?.appGreeted(send)
      },
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

  // The Host's Slack starts once the server exists: who keeps Slack is the server's to say.
  slackWiring?.start()

  handlePty = attachPtyHost({ registry, broadcast: (m) => server.broadcast(m) })
  handleProc = attachProcHost({ registry: procs, broadcast: (m) => server.broadcast(m) })

  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => leave(signal))
}

void main()

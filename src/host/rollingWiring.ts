// The one composition of the Host's rolling (S6 plan R2, R7, R17, R25, R32): the coordinators
// (rolling.ts), the roll tap (rollTapHost.ts), the app-gone watch (appGone.ts) and its takeover
// (takeover.ts), and the hooks `createHostOrch` takes from them. `index.ts` builds the Host through this,
// and so does the S6 rig (rolling.integration.test.ts), so the rig tests the wiring the Host really runs.
//
// **Late-bound on purpose** (preflight B2), as drivingWiring.ts is: `orch`, `server` and `exits` do not
// exist yet when index.ts calls this — `orch` is built with the hooks this answers — so every argument
// that names them is a function, read at the call. Building reads none of them.
//
// **The accounts are read before the first takeover** (Task 12's hard carry): a restore's codex locate
// with no accounts loaded aborts for good, and the takeover never retries a chain it restored. So a gone
// decision that lands before the first `refresh()` has finished waits for it, and a takeover is held
// until a read has succeeded (`accountsRead`, the Task 16 review).
//
// **Disposed when retire starts** (index.ts's `leave`): the tick and the app-gone watch stop, a takeover
// still waiting on that first read never runs, no newly spawned session is adopted, every chain is
// quieted (`mayAct` answers retiring), and the coordinators' own timers stop.
//
// Imports only core modules, node builtins and the Host's own modules: this bundles into the Host.
import os from 'node:os'
import { liveAppPid } from '../core/host/pidFile'
import { hostWorkerBaseEnv } from '../core/host/spawn'
import { hostMayAct } from '../core/host/rollOwner'
import { HOST_YIELD_CHAT_TAKEOVER, type HostMessage } from '../core/host/protocol'
import { buildResumeNote, buildResumePacket } from '../core/orchestration/exec/resumePacket'
import { absorbBlocks, blocksOfChange, parseBlocks } from '../core/rolling/blockWire'
import { bindNativeSession } from '../core/orchestration/state'
import type { Lang } from '../core/i18n'
import { createAppGoneWatch } from './appGone'
import { createHostChats, type HostChats, type HostChatsDeps } from './hostChats'
import type { HostExits } from './exits'
import type { HostOrch } from './orch'
import type { ProcHolders } from './procHolders'
import type { ProcRegistry } from './procRegistry'
import type { PtyRegistry } from './registry'
import { createHostRolling, type HostRolling, type HostRollingDeps } from './rolling'
import { createHostRollTap, type HostRollTap } from './rollTapHost'
import { createRollJournal, rollJournalPath, type RollJournal } from './rollJournal'
import type { HostServer } from './server'
import type { HostSpawner } from './spawner'
import { takeOverChats, takeOverSessions } from './takeover'

/** How often the accounts and the resume strategy are read again, and the app-gone watch ticks (R13). */
export const ROLLING_TICK_MS = 15_000

export interface HostRollingWiring {
  rolling: HostRolling
  tap: HostRollTap
  /** The Host's chat sessions (chat takeover Task 5): the adapters the takeover takes on a gone app's
   *  chat procs. Disposed with the wiring. */
  chats: HostChats
  /** Spread into createHostOrch's deps. */
  orchHooks: {
    rolling: HostRolling
    rolledInto(sessionId: string): { id: string; accountId: string } | null
    rekeyRolled(oldSessionId: string, info: { id: string; accountId: string }): Promise<void>
    /** The roll journal (S6 limits D5), for the app's `roll-journal` call. */
    rollJournal: RollJournal
    /** The Host's chat sessions, for `chats pending`/`chats answer` and P10's Host-writer routes. */
    chats: HostChats
    /** True unless a socket holds the session's chat proc without the chat-takeover yield (an older app,
     *  which has no chatAnswer). A session with no live proc here is left to the app to answer. */
    chatAppAnswers(sessionId: string): boolean
  }
  /** Chained with the driving's onAppsChanged in index.ts. */
  onAppsChanged(): void
  /** An app was just answered its hello (server `onAppGreeted`): it is sent this Host's whole block
   *  registry, once (S6 D4). Never throws. */
  appGreeted(send: (m: HostMessage) => void): void
  /** A `blocks` message from a greeted app: absorbed, never broadcast back (no echo; D3). A malformed
   *  one is ignored (R3). Never throws. */
  blocksFromApp(m: unknown): void
  dispose(): void
}

export function composeHostRolling(a: {
  profileDir: string
  platform: NodeJS.Platform
  registry: PtyRegistry
  /** The line processes and which app sockets hold them (chat takeover Task 5). */
  procs: ProcRegistry
  procHolders: ProcHolders
  version: string
  spawner: HostSpawner
  exits(): Pick<HostExits, 'holdersOf'>
  server(): Pick<HostServer, 'hasApp' | 'yieldsOf' | 'broadcast' | 'act'>
  orch(): Pick<HostOrch, 'ready' | 'state' | 'internalDeps'>
  lang(): Lang
  log(m: string): void
  nowIso(): string
  /** Test seams. */
  every?(ms: number, fn: () => void): () => void
  after?(ms: number, fn: () => void): () => void
  appPid?(): number | null
  rollingDeps?: Partial<HostRollingDeps>
  chatsDeps?: Partial<HostChatsDeps>
}): HostRollingWiring {
  /** A log line never throws (constraint 14). */
  const log = (m: string): void => {
    try {
      a.log(m)
    } catch {
      /* nowhere to say it */
    }
  }
  const every =
    a.every ??
    ((ms: number, fn: () => void): (() => void) => {
      const h = setInterval(fn, ms)
      h.unref?.()
      return () => clearInterval(h)
    })

  /** Set when retire starts. From then on nothing here starts a takeover, adopts a chain or lets one act. */
  let disposed = false

  const tap = createHostRollTap({
    orch: () => a.orch(),
    retarget: (x) => a.spawner.retarget(x),
    log,
    now: () => a.nowIso()
  })

  // S6 limits D5: what rolls while no app is attached is journaled, for the next app to announce.
  const journal = createRollJournal({ filePath: rollJournalPath(a.profileDir), log, nowIso: () => a.nowIso() })

  // Chat takeover Task 5: the Host's chat adapters (built before the rolling, which rolls their chains:
  // Task 6), over the same proc registry and holders the server
  // feeds. A turn while the app is the writer goes to the app's chatSend (server.act), read at the call.
  const chats = createHostChats({
    procs: a.procs,
    holders: a.procHolders,
    platform: a.platform,
    homeDir: os.homedir(),
    version: a.version,
    baseEnv: hostWorkerBaseEnv(process.env),
    askApp: (n, args) => a.server().act(n, args),
    log,
    ...a.chatsDeps
  })

  const rolling = createHostRolling({
    profileDir: a.profileDir,
    platform: a.platform,
    registry: a.registry,
    spawner: a.spawner,
    // R1, asked at every decision a chain makes: an older app holding the pty quiets it in the same turn.
    mayAct: (pty) =>
      hostMayAct({
        announces: true,
        retiring: disposed || a.spawner.isRetiring(),
        holders: a.exits().holdersOf(pty),
        yieldsOf: (s) => a.server().yieldsOf(s)
      }),
    // Task 6: the same R1 for a chat proc, over its holders and the chat-takeover yield (P11).
    chats,
    chatMayAct: (p) =>
      hostMayAct({
        announces: true,
        retiring: disposed || a.spawner.isRetiring(),
        holders: a.procHolders.holdersOf(p),
        yieldsOf: (s) => a.server().yieldsOf(s),
        yieldName: HOST_YIELD_CHAT_TAKEOVER
      }),
    tap,
    // R22, the app's two forms (ipc.ts) over the Host's state — after the load, as the tap reads it: before
    // it the state is empty and every session would read as one with no Dispatch.
    resumeText: async (sid, form) => {
      await a.orch().ready()
      const st = a.orch().state()
      return form === 'update' ? buildResumeNote(sid, st, { log }) : buildResumePacket(sid, st, { log })
    },
    // The body the app's onNativeSession has (ipc.ts), bound through setState so the event derives. After
    // the load for the reason above, and never a commit over a state that was not read yet. The callers
    // are synchronous, so the write is fired and forgotten, with its catch.
    onNativeSession: (sid, native) => {
      void a
        .orch()
        .ready()
        .then(async () => {
          const st = a.orch().state()
          const open = st.dispatches.find((x) => x.sessionId === sid && !x.endedAt)
          if (!open) return
          const r = bindNativeSession(st, { dispatchId: open.id, nativeSessionId: native })
          if (r.ok && r.state !== st) await a.orch().internalDeps().setState(r.state)
        })
        .catch((err) => log(`native session bind failed session=${sid}: ${String(err)}`))
    },
    // Both pushes go to every greeted app (Task 13). `session-rolled` carries the new session's pty, which
    // the app adopts before it forwards the rekey (Task 14).
    // With no app attached, the event is journaled too (D5): nobody else hears it. Its own try, after the
    // broadcast, so neither costs the other.
    // A chat roll's push has no pty and names the new proc instead (Task 6), for the app to adopt it.
    onEvent: (e) => {
      const rolledMessage = (x: Extract<typeof e, { t: 'session-rolled' }>): HostMessage => {
        const ptyId = a.registry.sessionPty(x.info.id)
        const procId = ptyId === null ? chats.procOf(x.info.id) : null
        return { ...x, ptyId, ...(procId !== null ? { procId } : {}) }
      }
      const m: HostMessage = e.t === 'session-rolled' ? rolledMessage(e) : e
      // Final review M4: a chat roll's push names a proc, and only an app that yields chat-takeover
      // adopts it as the new half of a roll. An older one would adopt the proc in its sweep, announce a
      // tab, then re-point the old tab to it as well: two tabs for one session.
      if (m.t === 'session-rolled' && m.procId !== undefined) a.server().broadcast(m, (y) => y.has(HOST_YIELD_CHAT_TAKEOVER))
      else a.server().broadcast(m)
      try {
        if (!a.server().hasApp()) journal.append(e)
      } catch (err) {
        log(`a roll event could not be journaled: ${String(err)}`)
      }
    },
    lang: () => a.lang(),
    ...a.rollingDeps
  })

  // S6 D4: every change of the Host's block registry goes to the greeted clients. An absorb() fires no
  // change, so what an app sent is never broadcast back to it. After retire starts nothing is sent.
  const stopBlocks = rolling.blocks.onChange((e) => {
    if (disposed) return
    try {
      a.server().broadcast({ t: 'blocks', ...blocksOfChange(e) })
    } catch (err) {
      log(`a block change could not be broadcast: ${String(err)}`)
    }
  })

  a.spawner.onSpawned((info, account) => {
    if (!disposed) rolling.adoptSpawned(info, account)
  })
  a.spawner.onRolloutLocated((s, c, p) => {
    if (!disposed) rolling.attachFresh(s, c, p)
  })

  /** Each skipped (session, reason) once: the watch runs the pass again on every no-app tick (R13). */
  const skipsLogged = new Set<string>()
  /** Chat procs whose adopt failed, by the note they failed with (fix round 1, Minor 1). */
  const chatAdoptFailed = new Map<string, string>()
  let unreadLogged = false
  const takeOver = (): void => {
    if (disposed) return
    // Task 16 review: the first read finishing is not enough, it must have succeeded — with no accounts a
    // codex restore's locate aborts for good. The watch runs the pass again on every no-app tick (R13),
    // and the tick reads the accounts first, so the pass runs as soon as a read succeeds.
    if (!rolling.accountsRead()) {
      if (!unreadLogged) log('takeover held: accounts.json was never read — it runs once a read succeeds')
      unreadLogged = true
      return
    }
    const { skipped } = takeOverSessions({
      hasApp: () => a.server().hasApp(),
      announces: () => true,
      retiring: () => disposed || a.spawner.isRetiring(),
      entries: () => a.registry.list(),
      holdersOf: (p) => a.exits().holdersOf(p),
      note: (p, patch) => a.registry.note(p, patch),
      resume: (p) => a.registry.resume(p),
      hasChain: (id) => rolling.has(id),
      restore: (info, snap) => rolling.restore(info, snap),
      log
    })
    // The chat twin (spec §3.3), in the same pass: a gone app's chat procs, with or without a chain.
    const chatPass = takeOverChats({
      hasApp: () => a.server().hasApp(),
      announces: () => true,
      retiring: () => disposed || a.spawner.isRetiring(),
      entries: () => a.procs.list(),
      holdersOf: (p) => a.procHolders.holdersOf(p),
      note: (p, patch) => a.procs.note(p, patch),
      hasChain: (id) => rolling.has(id),
      held: (id) => chats.has(id),
      restore: (info, snap) => rolling.restore(info, snap),
      unregister: (id) => rolling.unregister(id),
      adopt: (e) => chats.adopt(e) !== null,
      adoptFailed: chatAdoptFailed,
      log
    })
    for (const s of [...skipped, ...chatPass.skipped]) {
      const key = `${s.sessionId} ${s.why}`
      if (skipsLogged.has(key)) continue
      skipsLogged.add(key)
      log(`takeover: ${s.sessionId} skipped — ${s.why}`)
    }
  }

  // Task 12's hard carry: the first read of the accounts finishes before any takeover. `refresh` never
  // rejects (it logs a failed read and keeps the last good one), and the catch is the net under that.
  let refreshed = false
  const firstRefresh = rolling
    .refresh()
    .catch((err) => log(`the first rolling refresh failed: ${String(err)}`))
    .finally(() => {
      refreshed = true
    })

  const watch = createAppGoneWatch({
    hasApp: () => a.server().hasApp(),
    appPid: a.appPid ?? (() => liveAppPid(a.profileDir)),
    // Synchronous once the first read is done, so the mark and the chain land in the pass that decided.
    onGone: () => {
      if (refreshed) return takeOver()
      log('the app is gone — the takeover waits for the first accounts read')
      void firstRefresh.then(() => {
        try {
          takeOver()
        } catch (err) {
          log(`the takeover after the first accounts read failed: ${String(err)}`)
        }
      })
    },
    log,
    ...(a.after ? { after: a.after } : {})
  })

  // Each isolated: a failed read must not cost the watch its tick, nor the reverse. The watch ticks after
  // the read settles, so a takeover held for want of accounts runs on the tick whose read succeeded.
  const stopTick = every(ROLLING_TICK_MS, () => {
    if (disposed) return
    void rolling
      .refresh()
      .catch((err) => log(`rolling refresh failed: ${String(err)}`))
      .finally(() => {
        if (disposed) return
        try {
          watch.tick()
        } catch (err) {
          log(`the app-gone watch could not tick: ${String(err)}`)
        }
      })
  })

  return {
    rolling,
    tap,
    chats,
    orchHooks: {
      rolling,
      // R7: the live session whose note says it was rolled from this one.
      rolledInto: (sessionId) => {
        for (const e of a.registry.list()) {
          if (!e.alive || e.meta?.kind !== 'session') continue
          if (e.meta.restore.rolledFrom !== sessionId) continue
          return { id: e.meta.id, accountId: String(e.meta.restore.accountId) }
        }
        return null
      },
      rekeyRolled: (oldSessionId, info) => tap.onRolled(oldSessionId, info),
      rollJournal: journal,
      chats,
      chatAppAnswers: (sessionId) => {
        const procId = chats.procOf(sessionId)
        if (procId === null) return true
        return a.procHolders
          .holdersOf(procId)
          .every((s) => a.server().yieldsOf(s)?.has(HOST_YIELD_CHAT_TAKEOVER) === true)
      }
    },
    // Isolated (constraint 14): this runs inside a hello or a socket close, and a throw must cost neither.
    onAppsChanged: () => {
      if (disposed) return
      try {
        watch.appsChanged()
      } catch (err) {
        log(`the app-gone watch could not take an app attaching or leaving: ${String(err)}`)
      }
    },
    // Date.now() is the rolling's own clock here: createHostRolling passes no `now` to its coordinators,
    // so they read Date.now() too, and the wiring carries only the ISO `nowIso`. One clock either way.
    appGreeted: (send) => {
      try {
        send({ t: 'blocks', ...rolling.blocks.snapshot(Date.now()) })
      } catch (err) {
        log(`the block registry could not be sent to an app: ${String(err)}`)
      }
    },
    blocksFromApp: (m) => {
      try {
        const now = Date.now()
        const p = parseBlocks(m, now)
        if (p) absorbBlocks(rolling.blocks, p, now)
      } catch (err) {
        log(`an app's block records could not be absorbed: ${String(err)}`)
      }
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      stopBlocks()
      stopTick()
      watch.dispose()
      rolling.dispose()
      try {
        chats.dispose()
      } catch (err) {
        log(`the Host's chat sessions could not be disposed: ${String(err)}`)
      }
    }
  }
}

// The one composition of the Host's Slack (Slack in the Host, spec §3, plan rulings P4, P7, P9, P16): a
// read-only config reader over `<profile>/slack.json`, one SlackNotifier, one SlackInboxController, the
// registration that follows the Host's registries (slackSessions.ts), the sources that feed it and the
// app's forwarded events (slackSources.ts, Task 6), where a reply goes (slackRoutes.ts, Task 7), and the
// owner gate that holds the socket and the transport only while no attached app keeps Slack (the hello
// yield `slack`, P4).
//
// **Exactly one socket per profile.** The Host opens its socket only when it has the SDK and every
// attached app yields `slack` (or no app is attached), and an app that keeps Slack attaching closes it
// before anything else is done (`onAppsChanged` rides the hello, before its reply). Every change of
// ownership goes through one queue (`settle`), and the inbox controller serializes its own teardown and
// build, so a close and an open never overlap.
//
// **Read only.** slack.json is read through SlackConfigReader, which has no way to change the file; the
// app's settings screen stays its only writer (spec S4).
//
// **Late-bound on purpose**, as rollingWiring.ts is: `server` does not exist when index.ts builds this,
// so it is a function, read at the call, and nothing is opened until `start()`.
//
// Imports only core modules, node builtins and this folder: this bundles into the Host.
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { HOST_YIELD_SLACK } from '../core/host/protocol'
import { SlackConfigReader, type SlackConfig } from '../core/slack/config'
import { SlackNotifier } from '../core/slack/notifier'
import { SlackInboxController, type SocketClient } from '../core/slack/inbox'
import type { Lang } from '../core/i18n'
import { CodexRolloutWatcher } from '../core/sessions/codexRolloutWatcher'
import { findClaudeTranscript } from '../core/history/strategies/claude'
import type { PtyRegistry } from './registry'
import type { ProcRegistry } from './procRegistry'
import type { HostServer } from './server'
import type { HostSlackSdk } from './slackSdk'
import type { HostRollEvent, HostRolling } from './rolling'
import type { HostChats } from './hostChats'
import { ROLLING_TICK_MS } from './rollingWiring'
import { createHostSlackSessions } from './slackSessions'
import { createHostSlackSources } from './slackSources'
import { hostInboxRoutes } from './slackRoutes'

export interface HostSlackWiring {
  notifier: SlackNotifier
  /** The SDK is there and no attached app keeps Slack (P4). */
  active(): boolean
  /** Builds nothing until the server exists; index.ts calls it once, right after startHostServer. */
  start(): void
  /** slack.json read again and applied (the app's slack-reload). Never rejects. */
  reload(): Promise<void>
  onAppsChanged(): void
  /** A greeted app's `slack-event` body (slackSources.ts drops what the Host sources itself). Never throws. */
  forwarded(m: unknown): void
  /** The rolling's tap: every roll event of a chain this Host holds. Never throws. */
  onRollEvent(e: HostRollEvent): void
  /** The rolling's hook tap: every hook event of the profile. Never throws. */
  onHookEvent(sessionId: string, payload: unknown): void
  /** Socket closed, timers stopped. Never rejects. */
  dispose(): Promise<void>
}

/** The Host's Slack log: `<profile>/slack.log`, the file the app's Slack writes too, each line marked
 *  `[host]` (P16), so one file tells what happened to a session whichever process posted. Never throws. */
export function hostSlackLog(profileDir: string): (m: string) => void {
  const file = path.join(profileDir, 'slack.log')
  return (m) => {
    try {
      appendFileSync(file, `${new Date().toISOString()} [host] ${m}\n`)
    } catch {
      /* a log line never costs a notice */
    }
  }
}

function defaultEvery(ms: number, fn: () => void): () => void {
  const h = setInterval(fn, ms)
  h.unref?.()
  return () => clearInterval(h)
}

export function composeHostSlack(a: {
  profileDir: string
  sdk: HostSlackSdk | null
  registry: PtyRegistry
  procs: ProcRegistry
  statusLinePayload(sessionId: string): Promise<unknown | null>
  /** The chat adapters this Host holds (their events are its own source), or null. */
  chats: Pick<HostChats, 'has' | 'info' | 'subscribe' | 'isWriter' | 'send' | 'requests' | 'answerCard'> | null
  /** The rolling: which chains this Host holds (their rolls are its own source) and its accounts snapshot,
   *  the one read of accounts.json the Host keeps (Task 6 replaces Task 5's own snapshot with it). */
  rolling: Pick<HostRolling, 'has' | 'account'> | null
  server(): Pick<HostServer, 'appsKeep' | 'hasApp' | 'act'>
  lang(): Lang
  /** Test seams. */
  log?(m: string): void
  readConfig?(): Promise<SlackConfig>
  every?(ms: number, fn: () => void): () => void
  findTranscript?(configDir: string, threadId: string): Promise<string | null>
}): HostSlackWiring {
  const raw = a.log ?? hostSlackLog(a.profileDir)
  /** A log line never throws (R3). */
  const log = (m: string): void => {
    try {
      raw(m)
    } catch {
      /* nowhere to say it */
    }
  }
  const reader = new SlackConfigReader(path.join(a.profileDir, 'slack.json'))
  const readConfig = a.readConfig ?? (() => reader.load())
  const lang = (): Lang => {
    try {
      return a.lang()
    } catch {
      return 'en'
    }
  }
  let disposed = false
  let started = false
  let isActive = false

  // P9: the thread keys go into whichever entry carries the session, straight through the registry.
  const noteThread = (sid: string, patch: Record<string, unknown>): void => {
    const pty = a.registry.sessionPty(sid)
    if (pty !== null) return a.registry.note(pty, patch)
    const proc = a.procs.list().find((e) => e.alive && e.meta?.kind === 'chat' && e.meta.id === sid)
    if (proc) a.procs.note(proc.id, patch)
  }
  const getAccount = (id: string) => {
    try {
      return a.rolling?.account(id) ?? null
    } catch {
      return null
    }
  }
  // R3: every dependency the notifier calls as `void this.x()` settles, whatever the source does.
  const notifier = new SlackNotifier({
    getAccount,
    readStatusPayload: (id) => {
      try {
        return Promise.resolve(a.statusLinePayload(id)).catch(() => null)
      } catch {
        return Promise.resolve(null)
      }
    },
    lang,
    log,
    ...(a.sdk ? { createPoster: (t: string) => a.sdk!.createPoster(t) } : {}),
    remember: (sid, patch) => noteThread(sid, patch)
  })
  const inbox = new SlackInboxController({
    makeDeps: (channelId, memberId) => ({
      channelId,
      memberId,
      lang,
      log,
      resolveSession: (ts) => notifier.resolveSessionByThread(ts),
      postNote: (ts, text) => notifier.postThreadNote(ts, text),
      isOwnMessage: (ts) => notifier.isOwnMessage(ts),
      pendingChoiceShape: (sid) => notifier.pendingChoiceShape(sid),
      // Task 7: a terminal reply into its pty, a chat reply and a card answer by the writer rule.
      ...hostInboxRoutes({ registry: a.registry, procs: a.procs, chats: a.chats, notifier, server: a.server })
    }),
    // A constructor that throws would reject the controller's queue, and every later apply and stop
    // behind it would never run: the throw becomes a start that fails, which SlackInbox logs.
    createClient: (token): SocketClient => {
      try {
        return a.sdk!.createClient(token)
      } catch (err) {
        return {
          on: () => undefined,
          start: () => Promise.reject(err),
          disconnect: async () => {}
        }
      }
    },
    isQuitting: () => disposed
  })
  // P12: the Host's own codex rollout watcher, for the codex terminal sessions with Slack only; no
  // `remember` (the app and the spawner already note the mapping).
  const codex = new CodexRolloutWatcher({
    getAccount,
    onTurnComplete: (sid, p) => {
      try {
        notifier.onCodexTurnComplete(sid, p)
      } catch (err) {
        log(`slack: a codex turn end of ${sid} could not be told: ${String(err)}`)
      }
    },
    log
  })
  const sources = createHostSlackSources({
    notifier,
    chats: a.chats,
    rolling: a.rolling,
    codex,
    findTranscript: a.findTranscript ?? findClaudeTranscript,
    log
  })
  // Built here, before `start`, so the registries are followed from composition on.
  const sessions = createHostSlackSessions({
    registry: a.registry,
    procs: a.procs,
    notifier,
    log,
    active: () => isActive,
    onRegistered: (info, restore) => sources.sessionRegistered(info, restore),
    onNoted: (info, restore) => sources.sessionNoted(info, restore),
    onEnded: (sid) => sources.sessionEnded(sid)
  })

  let queue: Promise<void> = Promise.resolve()
  const want = (): boolean => {
    if (!started || disposed || a.sdk === null) return false
    try {
      return !a.server().appsKeep(HOST_YIELD_SLACK)
    } catch {
      // Unsure who keeps Slack: holding no socket is the side that never makes two.
      return false
    }
  }
  /** One settle at a time (the SlackInboxController reason): a reload racing an app leaving must not
   *  apply an older read over a newer one, and a close must be done before the next open. Each settle
   *  reads who keeps Slack when it runs, not when it was asked, so the last change wins. Never rejects. */
  const settle = (why: string): Promise<void> => {
    queue = queue
      .then(async () => {
        if (want()) {
          let cfg: SlackConfig
          try {
            cfg = await readConfig()
          } catch (err) {
            log(`slack.json could not be read (${why}): ${err instanceof Error ? err.name : 'unknown'}`)
            return
          }
          if (!want()) return
          notifier.applyConfig(cfg)
          await inbox.apply(cfg)
          if (!isActive) log(`this Host owns Slack now (${why})`)
          isActive = true
          // Every activation reads the notes again: a record from an earlier activation takes the thread
          // the app noted while it kept Slack (Task 6, the Task 5 carry).
          sessions.reconcile({ fromNotes: true })
        } else {
          if (isActive) log(`this Host leaves Slack alone (${why})`)
          isActive = false
          notifier.setTransport(null, null)
          await inbox.stop()
        }
      })
      .catch((err) => log(`slack settle failed (${why}): ${String(err)}`))
    return queue
  }
  const stopTick = (a.every ?? defaultEvery)(ROLLING_TICK_MS, () => {
    if (!disposed) sessions.reconcile()
  })
  return {
    notifier,
    active: () => isActive,
    start: () => {
      if (started || disposed) return
      started = true
      void settle('start')
    },
    reload: () => settle('slack-reload'),
    onAppsChanged: () => {
      if (started) void settle('an app attached or left')
    },
    forwarded: (m) => {
      if (!disposed) sources.forwarded(m)
    },
    onRollEvent: (e) => {
      if (!disposed) sources.onRollEvent(e)
    },
    onHookEvent: (sid, p) => {
      if (!disposed) sources.onHookEvent(sid, p)
    },
    dispose: async () => {
      if (disposed) return
      disposed = true
      stopTick()
      sessions.dispose()
      sources.dispose()
      codex.stop()
      isActive = false
      await queue
      try {
        notifier.setTransport(null, null)
      } catch {
        /* the socket below is what matters */
      }
      await inbox.stop().catch((err) => log(`the Slack socket did not close cleanly: ${String(err)}`))
    }
  }
}

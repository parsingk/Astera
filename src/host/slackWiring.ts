// The one composition of the Host's Slack (Slack in the Host, spec §3, plan rulings P4, P7, P9, P16): a
// read-only config reader over `<profile>/slack.json`, one SlackNotifier, one SlackInboxController, the
// registration that follows the Host's registries (slackSessions.ts), and the owner gate that holds the
// socket and the transport only while no attached app keeps Slack (the hello yield `slack`, P4).
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
import type { Account } from '../core/types'
import type { PtyRegistry } from './registry'
import type { ProcRegistry } from './procRegistry'
import type { HostServer } from './server'
import type { HostSlackSdk } from './slackSdk'
import type { HostRollEvent } from './rolling'
import { ROLLING_TICK_MS } from './rollingWiring'
import { createHostSlackSessions } from './slackSessions'

export interface HostSlackWiring {
  notifier: SlackNotifier
  /** The SDK is there and no attached app keeps Slack (P4). */
  active(): boolean
  /** Builds nothing until the server exists; index.ts calls it once, right after startHostServer. */
  start(): void
  /** slack.json read again and applied (the app's slack-reload). Never rejects. */
  reload(): Promise<void>
  onAppsChanged(): void
  /** Task 6. */
  forwarded(m: unknown): void
  onRollEvent(e: HostRollEvent): void
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

/** How long an accounts snapshot answers before a read is started again. */
export const ACCOUNT_SNAPSHOT_MS = 15_000

/** The notifier asks for an account synchronously (its message prefix), and the profile's accounts.json
 *  is read asynchronously: so the answer is the last read, and a read older than `maxAgeMs` starts
 *  another in the background. A failed read keeps the last good snapshot and is logged. Until the first
 *  read lands, no account resolves (a notice then goes without its label). Task 6 replaces this with the
 *  rolling's own snapshot (`HostRolling.account`). */
export function createAccountSnapshot(a: {
  read(): Promise<Account[]>
  log(m: string): void
  now?(): number
  maxAgeMs?: number
}): { of(accountId: string): Account | null } {
  const now = a.now ?? Date.now
  const maxAge = a.maxAgeMs ?? ACCOUNT_SNAPSHOT_MS
  let accounts: Account[] = []
  let readAt: number | null = null
  let reading = false
  const refresh = (): void => {
    if (reading) return
    reading = true
    readAt = now()
    let p: Promise<Account[]>
    try {
      p = a.read()
    } catch (err) {
      p = Promise.reject(err)
    }
    p.then((got) => {
      accounts = got
    })
      .catch((err: unknown) => {
        try {
          a.log(`accounts.json could not be read for Slack: ${err instanceof Error ? err.name : 'unknown'}`)
        } catch {
          /* nowhere to say it */
        }
      })
      .finally(() => {
        reading = false
      })
  }
  return {
    of: (accountId) => {
      if (readAt === null || now() - readAt >= maxAge) refresh()
      return accounts.find((x) => x.id === accountId) ?? null
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
  accountOf(accountId: string): Account | null
  server(): Pick<HostServer, 'appsKeep' | 'hasApp' | 'act'>
  lang(): Lang
  /** Test seams. */
  log?(m: string): void
  readConfig?(): Promise<SlackConfig>
  every?(ms: number, fn: () => void): () => void
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
  // R3: every dependency the notifier calls as `void this.x()` settles, whatever the source does.
  const notifier = new SlackNotifier({
    getAccount: (id) => {
      try {
        return a.accountOf(id)
      } catch {
        return null
      }
    },
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
      // Task 7 routes replies.
      write: () => false
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
  // Built here, before `start`, so the registries are followed from composition on.
  const sessions = createHostSlackSessions({ registry: a.registry, procs: a.procs, notifier, log, active: () => isActive })

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
          sessions.reconcile()
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
    // Task 6.
    forwarded: () => {},
    onRollEvent: () => {},
    onHookEvent: () => {},
    dispose: async () => {
      if (disposed) return
      disposed = true
      stopTick()
      sessions.dispose()
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

// What the Host's Slack notifier is told, and by whom (Slack in the Host, spec S3 and §3.3, plan rulings
// P11, P12). Each session's notices come from one source:
//
// - **The Host's own observation** for every session it holds: hook events (the rolling's watcher, through
//   its tap), the rolls of the chains it holds (the rolling's `onRollEvent`), the events of the chat
//   adapters it holds (`HostChats`), codex turn ends of the codex terminal sessions it watches (its own
//   `CodexRolloutWatcher`, P12), and pty output and exits (slackSessions.ts, Task 5).
// - **The app's forwarded `slack-event`** for what only the app decodes: the chat events of a session
//   whose adapter is the app's, and the rolls of a chain the app holds. A forwarded event for a session
//   the Host sources itself is dropped (logged once per session and kind), so nothing is posted twice.
//
// **Transcript paths (P11).** A chat turn's summary is read from the file the CLI writes, through a getter
// read at turn end. The paths are learnt as the events pass: a codex `ready`'s rollout, the path a
// forwarded event carried, and for claude a lookup by the thread (`findTranscript`), started on `ready` and
// again on a `status` while unknown, one lookup in flight per session.
//
// **Codex terminal sessions are watched only from a noted rollout** (an adaptation of the brief): the
// watcher's own scan works only right after a spawn, and a registration at an activation can come long
// after it; the Host's spawner and the app's watcher both note the path, so the watch starts when the note
// names it (`sessionNoted`), never from a scan here.
//
// Imports only core and this folder: this bundles into the Host.
import type { ChatEvent } from '../core/chat/types'
import { providerOf, type Provider } from '../core/providers/meta'
import { codexRolloutFromNote, type CodexRolloutWatcher } from '../core/sessions/codexRolloutWatcher'
import { parseSlackForwarded } from '../core/slack/forwarded'
import type { SlackNotifier } from '../core/slack/notifier'
import type { SessionInfo } from '../core/types'
import type { HostChats } from './hostChats'
import type { HostRollEvent, HostRolling } from './rolling'

export interface HostSlackSources {
  onHookEvent(sessionId: string, payload: unknown): void
  onRollEvent(e: HostRollEvent): void
  /** A `slack-event` body from a greeted app; dropped for a session the Host sources itself. Never throws. */
  forwarded(raw: unknown): void
  /** A session slackSessions registered, with its note (the codex watch starts here when it names a rollout). */
  sessionRegistered(info: SessionInfo, restore: Record<string, unknown>): void
  /** A registered session's note changed: a rollout noted after registration starts its watch. */
  sessionNoted(info: SessionInfo, restore: Record<string, unknown>): void
  sessionEnded(sessionId: string): void
  dispose(): void
}

export function createHostSlackSources(d: {
  notifier: Pick<SlackNotifier, 'onChatEvent' | 'onRollState' | 'onRolled' | 'onHookEvent' | 'onCodexTurnComplete'>
  chats: Pick<HostChats, 'has' | 'info' | 'subscribe'> | null
  rolling: Pick<HostRolling, 'has' | 'account'> | null
  codex: Pick<CodexRolloutWatcher, 'register' | 'unregister'>
  findTranscript(configDir: string, threadId: string): Promise<string | null>
  log(m: string): void
}): HostSlackSources {
  /** A log line never throws (R3). */
  const log = (m: string): void => {
    try {
      d.log(m)
    } catch {
      /* nowhere to say it */
    }
  }
  const paths = new Map<string, string>()
  const threads = new Map<string, { configDir: string; threadId: string }>()
  const looking = new Set<string>()
  const watched = new Set<string>()
  const dropped = new Set<string>()
  const drop = (kind: string, id: string): void => {
    const key = `${kind} ${id}`
    if (dropped.has(key)) return
    dropped.add(key)
    log(`slack: a forwarded ${kind} of ${id} dropped — this Host sources that session itself`)
  }
  const lookUp = (sid: string): void => {
    const t = threads.get(sid)
    if (!t || paths.has(sid) || looking.has(sid)) return
    looking.add(sid)
    let p: Promise<string | null>
    try {
      p = d.findTranscript(t.configDir, t.threadId)
    } catch (err) {
      p = Promise.reject(err)
    }
    void p
      .then((found) => {
        if (found) paths.set(sid, found)
      })
      .catch((err: unknown) => log(`slack: the transcript of ${sid} could not be looked up: ${String(err)}`))
      .finally(() => looking.delete(sid))
  }
  /** P11: what the turn summary will read, learnt from the events as they pass. */
  const learn = (sid: string, accountId: string, provider: Provider, e: ChatEvent, hint: string | null): void => {
    if (hint) paths.set(sid, hint)
    if (e.type === 'ready') {
      if (provider === 'codex') {
        if (e.rolloutPath) paths.set(sid, e.rolloutPath)
        return
      }
      const acc = d.rolling?.account(accountId)
      if (acc) threads.set(sid, { configDir: acc.configDir, threadId: e.threadId })
    }
    if (provider === 'claude' && (e.type === 'ready' || e.type === 'status')) lookUp(sid)
  }
  const chatEvent = (sid: string, accountId: string, provider: Provider, e: ChatEvent, hint: string | null): void => {
    learn(sid, accountId, provider, e, hint)
    d.notifier.onChatEvent(sid, e, { provider, transcriptPath: () => paths.get(sid) ?? null })
  }
  // The chats this Host holds an adapter for: their events are the Host's own to tell.
  const offChats =
    d.chats?.subscribe((sid, e) => {
      try {
        const i = d.chats!.info(sid)
        const acc = i ? d.rolling?.account(i.accountId) : null
        if (!i || !acc) return
        // A chat adopted after its `ready` never shows it: the thread its info carries stands in (P11).
        if (providerOf(acc) === 'claude' && i.threadId && !threads.has(sid)) threads.set(sid, { configDir: acc.configDir, threadId: i.threadId })
        chatEvent(sid, i.accountId, providerOf(acc), e, null)
      } catch (err) {
        log(`slack: a Host chat event of ${sid} could not be told: ${String(err)}`)
      }
    }) ?? null
  /** P12: a codex terminal session with Slack, watched from the rollout its note names. */
  const watch = (info: SessionInfo, restore: Record<string, unknown>): void => {
    if (watched.has(info.id) || info.kind === 'chat') return
    const acc = d.rolling?.account(info.accountId)
    if (!acc || providerOf(acc) !== 'codex') return
    const r = codexRolloutFromNote(restore)
    if (!r) return
    if (r.codexSessionId) d.codex.register(info, r.rolloutPath, r.codexSessionId)
    else d.codex.register(info, r.rolloutPath)
    watched.add(info.id)
  }
  /** A roll moves a watched codex chain to its new id and the rollout the roll resumed on. */
  const follow = (oldId: string, next: SessionInfo, dest?: string): void => {
    if (!watched.delete(oldId)) return
    d.codex.unregister(oldId)
    if (next.kind === 'chat' || dest === undefined) return
    d.codex.register(next, dest)
    watched.add(next.id)
  }
  return {
    onHookEvent: (sid, p) => {
      try {
        d.notifier.onHookEvent(sid, p)
      } catch (err) {
        log(`slack: a hook event of ${sid} failed: ${String(err)}`)
      }
    },
    onRollEvent: (e) => {
      try {
        if (e.t === 'roll-state') return d.notifier.onRollState(e.event)
        d.notifier.onRolled(e.oldSessionId, e.info)
        follow(e.oldSessionId, e.info, e.dest)
      } catch (err) {
        log(`slack: a Host roll event failed: ${String(err)}`)
      }
    },
    forwarded: (raw) => {
      try {
        const ev = parseSlackForwarded(raw)
        if (!ev) return drop('malformed event', 'an app')
        if (ev.kind === 'chat') {
          if (d.chats?.has(ev.sessionId)) return drop('chat event', ev.sessionId)
          return chatEvent(ev.sessionId, ev.accountId, ev.provider, ev.event, ev.transcriptPath)
        }
        if (ev.kind === 'roll-state') {
          if (d.rolling?.has(ev.event.sessionId)) return drop('roll state', ev.event.sessionId)
          return d.notifier.onRollState(ev.event)
        }
        if (d.rolling?.has(ev.info.id) || d.rolling?.has(ev.oldSessionId)) return drop('roll', ev.oldSessionId)
        d.notifier.onRolled(ev.oldSessionId, ev.info)
        follow(ev.oldSessionId, ev.info, ev.dest)
      } catch (err) {
        log(`slack: a forwarded event failed: ${String(err)}`)
      }
    },
    sessionRegistered: (info, restore) => {
      try {
        watch(info, restore)
      } catch (err) {
        log(`slack: the codex watch of ${info.id} could not start: ${String(err)}`)
      }
    },
    sessionNoted: (info, restore) => {
      try {
        watch(info, restore)
      } catch (err) {
        log(`slack: the codex watch of ${info.id} could not start: ${String(err)}`)
      }
    },
    sessionEnded: (id) => {
      if (watched.delete(id)) d.codex.unregister(id)
      paths.delete(id)
      threads.delete(id)
    },
    dispose: () => {
      try {
        offChats?.()
      } catch (err) {
        log(`slack: the Host chat events could not be let go: ${String(err)}`)
      }
      for (const id of watched) d.codex.unregister(id)
      watched.clear()
    }
  }
}

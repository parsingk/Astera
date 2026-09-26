// Which sessions the Host's Slack notifier knows, followed from the Host's two registries (Slack in the
// Host, spec §3.3, plan ruling P7). A live pty or proc whose note reads as a session with `slackNotify`
// is registered the moment it opens, with the thread its note names, and renamed from its note after
// that. Its output and its exit are fed to the notifier from the same registries: the Host sees every
// pty and proc it holds, so exits are the Host's for both kinds (P6).
//
// **A rolled session's new entry waits for the roll event** while the notifier still holds the session
// its note's `rolledFrom` names: `onRolled` carries the old record's thread onto the new id, and a
// registration here first would open a second root beside it. `reconcile()` (the rolling tick, and every
// activation) is the net that registers it once the old record is gone.
//
// **Nothing is registered while the Host is not active** (`active`). While an app keeps Slack, that app's
// notifier opens each root and notes it; a record made here meanwhile would hold no thread, and at the
// activation the Host would post a second root beside the one the note names. So the activation's
// reconcile registers each session reading its note as it is then. **A record from an earlier activation
// takes its note's thread then too** (`reconcile({ fromNotes: true })`, Task 6): the app may have opened a
// new root for the session in the meantime, and the note is newer than what the record remembers.
//
// Imports only core and this folder: this bundles into the Host.
import type { PtyMeta } from '../core/host/protocol'
import type { SessionInfo } from '../core/types'
import type { SlackNotifier } from '../core/slack/notifier'
import { chatInfoFromNote, sessionInfoFromNote } from '../core/sessions/noteInfo'
import { notedThreadOf } from '../core/slack/threadNote'
import type { PtyRegistry } from './registry'
import type { ProcRegistry } from './procRegistry'

export interface HostSlackSessions {
  /** Every live session entry considered again: the rolling tick's net, and every activation (P7). With
   *  `fromNotes` (an activation), a known record takes the thread its note names (Task 6). */
  reconcile(o?: { fromNotes?: boolean }): void
  dispose(): void
}

export function createHostSlackSessions(d: {
  registry: Pick<PtyRegistry, 'onMeta' | 'onData' | 'onExit' | 'list' | 'metaOf' | 'sessionPty'>
  procs: Pick<ProcRegistry, 'onMeta' | 'onExit' | 'list'>
  notifier: Pick<SlackNotifier, 'has' | 'register' | 'rename' | 'handleData' | 'handleExit' | 'adoptNoted'>
  /** Whether the Host owns Slack now. Default: always. Registration and renames wait for it; output and
   *  exits are fed whatever it says, so a record from an earlier activation still ends. */
  active?(): boolean
  /** Told after a registration and an exit (Task 6 hangs the codex watcher here). */
  onRegistered?(info: SessionInfo, restore: Record<string, unknown>): void
  onEnded?(sessionId: string): void
  /** Told when a known session's note changes (Task 6: a codex rollout noted after registration). */
  onNoted?(info: SessionInfo, restore: Record<string, unknown>): void
  log(m: string): void
}): HostSlackSessions {
  let disposed = false
  const infoOf = (meta: PtyMeta): SessionInfo | null => sessionInfoFromNote(meta) ?? chatInfoFromNote(meta)
  const consider = (meta: PtyMeta | null, fromNotes = false): void => {
    if (disposed || !meta || !(d.active?.() ?? true)) return
    const info = infoOf(meta)
    if (!info || info.slackNotify !== true) return
    if (d.notifier.has(info.id)) {
      d.notifier.rename(info.id, info.title)
      if (fromNotes) d.notifier.adoptNoted(info.id, notedThreadOf(meta.restore))
      d.onNoted?.(info, meta.restore)
      return
    }
    // P7: a roll's new entry is the roll event's to carry while the old record stands, or it opens a
    // second root beside the one onRolled hands over. reconcile() registers it once the old one is gone.
    const from = meta.restore.rolledFrom
    if (typeof from === 'string' && from !== info.id && d.notifier.has(from)) return
    d.notifier.register(info, { thread: notedThreadOf(meta.restore) })
    d.onRegistered?.(info, meta.restore)
  }
  /** A listener here runs inside a registry's fan-out: it never throws into it. */
  const safe = (what: string, fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      try {
        d.log(`slack sessions: ${what} failed: ${String(err)}`)
      } catch {
        /* nowhere to say it */
      }
    }
  }
  const offs: Array<() => void> = [
    d.registry.onMeta((_id, meta) => safe('a pty note', () => consider(meta))),
    d.procs.onMeta((_id, meta) => safe('a proc note', () => consider(meta))),
    d.registry.onData((ptyId, data) => {
      if (disposed) return
      const m = d.registry.metaOf(ptyId)
      if (m?.kind === 'session') safe('output', () => d.notifier.handleData({ sessionId: m.id, data }))
    }),
    d.registry.onExit((ptyId, exitCode) => {
      if (disposed) return
      const m = d.registry.metaOf(ptyId)
      // A respawn that keeps the id opens the new pty first (rolling.ts's rule): that exit is not its end.
      if (m?.kind !== 'session' || d.registry.sessionPty(m.id) !== null) return
      safe('an exit', () => {
        d.notifier.handleExit({ sessionId: m.id, exitCode })
        d.onEnded?.(m.id)
      })
    }),
    d.procs.onExit((procId, exitCode) => {
      if (disposed) return
      const all = d.procs.list()
      const m = all.find((e) => e.id === procId)?.meta
      if (m?.kind !== 'chat' || all.some((e) => e.alive && e.meta?.kind === 'chat' && e.meta.id === m.id)) return
      safe('a chat exit', () => {
        d.notifier.handleExit({ sessionId: m.id, exitCode })
        d.onEnded?.(m.id)
      })
    })
  ]
  return {
    reconcile: (o) => {
      for (const e of [...d.registry.list(), ...d.procs.list()]) if (e.alive) safe('reconcile', () => consider(e.meta, o?.fromNotes === true))
    },
    dispose: () => {
      disposed = true
      for (const off of offs) off()
    }
  }
}

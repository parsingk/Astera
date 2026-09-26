// Where a Slack reply goes in the Host (Slack in the Host Task 7, spec §3.4, plan rulings P10 and P18). The
// SlackInbox classifies and converts a reply; these are the four routes it hands the result to:
//
// - a terminal session's reply is typed into the live pty that carries it (the inbox turns a choice
//   screen's reply into keys first, from the notifier's pending tool, as the app does);
// - a chat reply with no card open is a turn, and a card's reply is its answer. Both follow the one-writer
//   rule (chat takeover spec §3.2): the Host adapter while the Host writes, otherwise the app, through
//   its chatSend for a turn and the `slackChatAnswer` act for a card (P10: questions too, not only
//   approvals). Neither path is tried after the other, so a turn or an answer is applied at most once.
//
// Every route that cannot deliver rejects (or answers false) with a reason; the inbox turns that into a
// thread note and a log line, and its message handler logs anything left (R3).
//
// Imports only core modules and this folder: this bundles into the Host.
import { HOST_ACT_SLACK_ANSWER } from '../core/host/protocol'
import type { ChatAnswer, ChatRequest } from '../core/chat/types'
import type { SlackInboxDeps } from '../core/slack/inbox'
import type { SlackNotifier } from '../core/slack/notifier'
import type { PtyRegistry } from './registry'
import type { ProcRegistry } from './procRegistry'
import type { HostChats } from './hostChats'
import type { HostServer } from './server'

export type HostInboxRoutes = Pick<SlackInboxDeps, 'write' | 'isChat' | 'pendingRequest' | 'deliverChat' | 'answerChat'>

/** A live chat proc carries this session id: the Host's own session list, adopted or not. */
const liveChat = (procs: Pick<ProcRegistry, 'list'>, sid: string): boolean =>
  procs.list().some((e) => e.alive && e.meta?.kind === 'chat' && e.meta.id === sid)

const NOBODY = 'nobody holds this session right now'

export function hostInboxRoutes(d: {
  registry: Pick<PtyRegistry, 'sessionPty' | 'write'>
  procs: Pick<ProcRegistry, 'list'>
  chats: Pick<HostChats, 'has' | 'isWriter' | 'send' | 'requests' | 'answerCard'> | null
  notifier: Pick<SlackNotifier, 'chatRequestOf'>
  server(): Pick<HostServer, 'hasApp' | 'act'>
}): HostInboxRoutes {
  return {
    // The live pty that carries the session. `sessionPty` answers null for an ended session (the inbox
    // then says so in the thread), and the registry's own liveness check drops a write to one that ended
    // between the lookup and the write; the inbox's Enter and later choice keys look it up again.
    write: (sid: string, data: string): boolean => {
      const pty = d.registry.sessionPty(sid)
      if (pty === null) return false
      d.registry.write(pty, data)
      return true
    },
    isChat: (sid: string): boolean => liveChat(d.procs, sid),
    // P18: the adapter's open list (less the note's answered ids) where the Host holds one, else the card
    // the notifier last heard of from the app's forwarded `request` events.
    pendingRequest: (sid: string): ChatRequest | null =>
      d.chats?.has(sid) ? (d.chats.requests(sid)[0] ?? null) : d.notifier.chatRequestOf(sid),
    deliverChat: async (sid: string, text: string): Promise<void> => {
      if (d.chats?.isWriter(sid)) return d.chats.send(sid, text)
      const server = d.server()
      if (!server.hasApp()) throw new Error(NOBODY)
      const r = (await server.act('chatSend', [sid, text])) as { sent?: unknown; reason?: unknown; pending?: unknown } | null
      if (r?.sent !== true) throw new Error(r?.pending ? 'a card is open in Astera' : String(r?.reason ?? 'Astera did not deliver it'))
    },
    answerChat: async (sid: string, requestId: string, answer: ChatAnswer): Promise<void> => {
      if (d.chats?.isWriter(sid)) return d.chats.answerCard(sid, requestId, answer)
      const server = d.server()
      if (!server.hasApp()) throw new Error(NOBODY)
      const r = (await server.act(HOST_ACT_SLACK_ANSWER, [sid, requestId, answer])) as { answered?: unknown; reason?: unknown } | null
      if (r?.answered !== true) throw new Error(`Astera did not answer it (${String(r?.reason ?? 'unknown')})`)
    }
  }
}

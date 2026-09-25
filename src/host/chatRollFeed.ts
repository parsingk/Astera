// What the Host's chat sessions tell its rolling coordinators (chat takeover Task 6, spec §3.3). The twin
// of the `core.chat.subscribe` block in the app's ipc.ts: a chat session writes no statusline and prints
// no limit on a screen, so the facts a pty chain reads there are pushed in from the adapter's events.
//
//  - codex `ready`: the thread and its rollout, to `attachChat`.
//  - claude `ready`: the thread now (`onChatMeta` with no transcript), then the transcript once a lookup
//    under the account's configDir finds it. A hit is applied only while the session still names that
//    thread (a `/clear` gives the conversation a new id under an in-flight lookup).
//  - `status`: both coordinators' `onChatStatus`, plus a claude lookup retry while none has landed (the
//    file is written with the conversation's first turn).
//  - `rateLimit`: the claude coordinator's `onChatLimit` (the claude adapter is the only one that emits it).
//  - `exit`: both coordinators' `handleExit`.
//
// R3: each coordinator call in its own try, each lookup promise ending in a catch that logs. One lookup
// per session at a time.
//
// Imports only core types: this bundles into the Host.
import type { RollingCoordinator } from '../core/rolling/claudeCoordinator'
import type { CodexRollingCoordinator } from '../core/rolling/codexCoordinator'
import type { ChatEvent } from '../core/chat/types'
import type { Account } from '../core/types'

export interface ChatRollFeedDeps {
  claude: Pick<RollingCoordinator, 'onChatMeta' | 'onChatStatus' | 'onChatLimit' | 'handleExit'>
  codex: Pick<CodexRollingCoordinator, 'attachChat' | 'onChatStatus' | 'handleExit'>
  providerOf(sessionId: string): 'claude' | 'codex' | null
  accountOf(sessionId: string): Account | null
  threadOf(sessionId: string): string | null
  findTranscript(configDir: string, threadId: string): Promise<string | null>
  log(m: string): void
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createChatRollFeed(d: ChatRollFeedDeps): (sessionId: string, e: ChatEvent) => void {
  /** Sessions whose claude transcript has been found: the status retry stops for them. */
  const found = new Set<string>()
  const finding = new Set<string>()
  const call = (sid: string, what: string, fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      d.log(`chat ${sid}: rolling could not take ${what}: ${errText(err)}`)
    }
  }
  const lookUp = (sid: string, threadId: string): void => {
    if (finding.has(sid)) return
    const account = d.accountOf(sid)
    if (!account) return
    finding.add(sid)
    let p: Promise<string | null>
    try {
      p = d.findTranscript(account.configDir, threadId)
    } catch (err) {
      p = Promise.reject(err)
    }
    p.then((file) => {
      if (file === null || d.threadOf(sid) !== threadId) return
      found.add(sid)
      call(sid, 'its transcript', () => d.claude.onChatMeta(sid, { claudeSessionId: threadId, transcriptPath: file }))
    })
      .catch((err: unknown) => d.log(`chat ${sid}: transcript lookup failed: ${errText(err)}`))
      .finally(() => finding.delete(sid))
  }
  return (sid, e) => {
    try {
      if (e.type === 'ready') {
        const provider = d.providerOf(sid)
        if (provider === 'codex') call(sid, 'its thread', () => d.codex.attachChat(sid, e.threadId, e.rolloutPath))
        if (provider === 'claude') {
          // A second ready is a new conversation (a `/clear`): its file does not exist yet.
          found.delete(sid)
          call(sid, 'its thread', () => d.claude.onChatMeta(sid, { claudeSessionId: e.threadId, transcriptPath: null }))
          lookUp(sid, e.threadId)
        }
      } else if (e.type === 'status') {
        call(sid, 'a status', () => d.claude.onChatStatus(sid, e.status))
        call(sid, 'a status', () => d.codex.onChatStatus(sid, e.status))
        if (!found.has(sid) && d.providerOf(sid) === 'claude') {
          const thread = d.threadOf(sid)
          if (thread) lookUp(sid, thread)
        }
      } else if (e.type === 'rateLimit') {
        call(sid, 'a limit', () => d.claude.onChatLimit(sid, e.info))
      } else if (e.type === 'exit') {
        found.delete(sid)
        call(sid, 'an exit', () => d.claude.handleExit({ sessionId: sid }))
        call(sid, 'an exit', () => d.codex.handleExit({ sessionId: sid }))
      }
    } catch (err) {
      d.log(`chat ${sid}: an event could not be fed to rolling: ${errText(err)}`)
    }
  }
}

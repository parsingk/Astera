// Settings › Security & Access' way to the Host (observe mode design §11): the Host's own `policies-*` and `audit-*`
// commands, sent over the app's `orch-call` as the app, one method a command the screen uses, so the renderer names no
// other command. Run detail's token totals come the same way, from the Host's `runs-get` and `tasks-get`: only the Host's
// token store knows them, and main's own command layer answers those two without. The Host checks everything; this only
// says what it answered.
import type { AuditApi } from '../../core/types'
import { hostSender } from './pluginsRoute'

type Call = Parameters<typeof hostSender>[0]['call']

/** Nothing here copies files the way an extensions change does, so every call waits the usual time. */
export function createAuditRoute(d: { call: Call }): AuditApi {
  const send = hostSender(d)
  return {
    policies: () => send('policies-show', {}),
    setMode: (mode) => send('policies-set-mode', { mode }),
    setOtherwise: (otherwise) => send('policies-set-otherwise', { otherwise }),
    addRule: (rule) => send('policies-rules-add', { ...rule }),
    editRule: (id, changes) => send('policies-rules-edit', { id, ...changes }),
    removeRule: (id) => send('policies-rules-remove', { id }),
    moveRule: (id, to) => send('policies-rules-move', { id, to }),
    resetRules: () => send('policies-rules-reset', {}),
    list: (q) => send('audit-list', { ...q }),
    summary: (q) => send('audit-summary', { ...q }),
    runTokens: (runId) => send('runs-get', { id: runId }),
    taskTokens: (taskId) => send('tasks-get', { id: taskId })
  }
}

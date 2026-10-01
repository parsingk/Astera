// One Task with its attempts (MCP design §3b), for the MCP get_task tool through the Host command
// `tasks-get`. The Task's own fields go through the CLI's public allowlist; the attempts carry no
// session id and no worker output.
import { TASK_PUBLIC_FIELDS } from './cliPublic'
import type { OrchState } from './state'
import type { Provider } from '../providers/meta'
import type { Outcome, RepairReason } from './types'

export interface TaskAttempt {
  id: string
  provider: Provider
  accountId: string
  repair?: RepairReason
  review?: true
  outcome?: Outcome
  startedAt: string
  endedAt?: string
}

export type TaskDetail = Record<string, unknown> & { attempts: TaskAttempt[]; openQuestionId?: string }

export function taskDetailOf(s: OrchState, taskId: string): TaskDetail | null {
  const task = s.tasks.find((t) => t.id === taskId)
  if (!task) return null
  const out: Record<string, unknown> = {}
  for (const f of TASK_PUBLIC_FIELDS) if (f in task) out[f] = (task as unknown as Record<string, unknown>)[f]
  const attempts = s.dispatches
    .filter((d) => d.taskId === taskId)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map(
      (d): TaskAttempt => ({
        id: d.id,
        provider: d.provider,
        accountId: d.accountId,
        ...(d.repair !== undefined ? { repair: d.repair } : {}),
        ...(d.review === true ? { review: true as const } : {}),
        ...(d.outcome !== undefined ? { outcome: d.outcome } : {}),
        startedAt: d.startedAt,
        ...(d.endedAt !== undefined ? { endedAt: d.endedAt } : {})
      })
    )
  const open = s.gates.find((g) => g.taskId === taskId && g.status === 'open')
  return { ...out, attempts, ...(open ? { openQuestionId: open.id } : {}) }
}

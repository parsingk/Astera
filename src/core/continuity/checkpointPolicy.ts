// Which journal events earn a deterministic checkpoint (spec §12.3, P0 design §7). Pure; the recorder
// (main/continuity/recorder.ts) reads git and writes the row.
import type { ContinuityEvent, ContinuityEventType } from './events'
import type { OrchState } from '../orchestration/state'

export type CheckpointKind =
  | 'attempt-started'
  | 'native-session-bound'
  | 'task-transition'
  | 'limit-stop'
  | 'resumed'
  | 'attempt-ended'
  | 'baseline'

/** ATTEMPT_LOST is absent on purpose: it is written at boot for a process that is already gone, and
 *  the reconciler (P1) inspects that worktree itself. */
const KIND_OF: Partial<Record<ContinuityEventType, CheckpointKind>> = {
  ATTEMPT_STARTED: 'attempt-started',
  AGENT_NATIVE_SESSION_BOUND: 'native-session-bound',
  AGENT_NATIVE_SESSION_CHANGED: 'native-session-bound',
  USAGE_LIMIT_DETECTED: 'limit-stop',
  ATTEMPT_RESUMED: 'resumed',
  ATTEMPT_COMPLETED: 'attempt-ended',
  ATTEMPT_FAILED: 'attempt-ended',
  ATTEMPT_EXITED: 'attempt-ended'
}

/** Priority when one write produces several reasons for the same dispatch: the first wins. */
const ORDER: CheckpointKind[] = [
  'attempt-started',
  'native-session-bound',
  'task-transition',
  'limit-stop',
  'resumed',
  'attempt-ended',
  'baseline'
]

export function checkpointsFor(
  events: ContinuityEvent[],
  state: OrchState
): Array<{ dispatchId: string; kind: CheckpointKind }> {
  const best = new Map<string, CheckpointKind>()
  const consider = (dispatchId: string, kind: CheckpointKind): void => {
    const cur = best.get(dispatchId)
    if (cur === undefined || ORDER.indexOf(kind) < ORDER.indexOf(cur)) best.set(dispatchId, kind)
  }
  for (const e of events) {
    if (e.dispatchId !== undefined) {
      const kind = KIND_OF[e.type]
      if (kind) consider(e.dispatchId, kind)
      continue
    }
    if (e.taskId !== undefined && e.type.startsWith('TASK_')) {
      // The worker that is doing this task, once it really exists (not the worker-start placeholder)
      const open = state.dispatches.find((d) => d.taskId === e.taskId && !d.endedAt)
      if (open && !open.sessionId.startsWith('pending:')) consider(open.id, 'task-transition')
    }
  }
  return [...best].map(([dispatchId, kind]) => ({ dispatchId, kind }))
}

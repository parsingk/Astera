// The four transitions a session task can make, as pure functions.
//
// **Nothing here decides anything.** Every one of these is called because something already said
// so — the person typed /astera-task, the agent called session-task-complete, a session exited.
// That is the whole point of this file replacing boundary.ts and completion.ts: the rules that
// used to guess now only record.
import type { SessionCheck, SessionWorkUnit } from './types'

export function startedTask(input: {
  id: string
  sessionId: string
  projectPath: string
  objective: string
  at: string
  startHead: string | null
  baselineDirtyFiles: string[]
}): SessionWorkUnit {
  return {
    id: input.id,
    sessionId: input.sessionId,
    projectPath: input.projectPath,
    objective: input.objective.trim(),
    status: 'active',
    startedAt: input.at,
    git: {
      startHead: input.startHead,
      baselineDirtyFiles: input.baselineDirtyFiles,
      observedChangedFiles: []
    },
    encounteredExternalGitChangeIds: []
  }
}

/** Ends the work. Accepts `active` and `interrupted` — the second is how a person closes something
 *  the agent walked away from. A unit that already ended is returned untouched: reopening is ruled
 *  out by the spec, and an app restart must not be able to rewrite a completion. */
export function completedTask(
  unit: SessionWorkUnit,
  input: { source: 'agent' | 'user'; at: string; checks?: SessionCheck[]; summary?: string }
): SessionWorkUnit {
  if (unit.status !== 'active' && unit.status !== 'interrupted') return unit
  return {
    ...unit,
    status: 'completed',
    endedAt: input.at,
    completion: { source: input.source, at: input.at },
    ...(input.checks && input.checks.length > 0 ? { checks: input.checks } : {}),
    ...(input.summary ? { resultSummary: input.summary } : {})
  }
}

export function cancelledTask(
  unit: SessionWorkUnit,
  input: { at: string; reason?: string }
): SessionWorkUnit {
  if (unit.status !== 'active' && unit.status !== 'interrupted') return unit
  return {
    ...unit,
    status: 'cancelled',
    endedAt: input.at,
    ...(input.reason ? { reason: input.reason } : {})
  }
}

/** Puts the work in front of the person. Only an active unit is interrupted — one that is already
 *  interrupted keeps its first reason, which is the one that explains how it got there. */
export function interruptedTask(
  unit: SessionWorkUnit,
  input: { at: string; reason: string }
): SessionWorkUnit {
  if (unit.status !== 'active') return unit
  return { ...unit, status: 'interrupted', endedAt: input.at, reason: input.reason }
}

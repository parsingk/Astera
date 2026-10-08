// The Jobs sidebar's one-shot actions (pause, resume, coordinator restart, delete), each through a door
// (lib/orchDoor.ts) so a paired Runtime's Job takes the same flow as this computer's (remote runtime design Phase 7).
// The bodies are the App's own, moved: the same confirmations, counts, choices and failure sentences.
import type { OrchSnapshot } from '../../../core/types'
import { findRun } from '../../../core/orchestration/snapshot'
import type { CommandReply, OrchDoor } from './orchDoor'

export interface ActionUi {
  t(key: string, params?: Record<string, string | number>): string
  confirm(o: { title: string; body: string; confirmLabel: string }): Promise<boolean>
  confirmChoices(o: {
    title: string
    body: string
    confirmLabel: string
    choices?: Array<{ id: string; label: string; hint?: string }>
  }): Promise<{ ok: boolean; checked: string[] }>
  error(message: string): void
  /** Hides folders from the history list. Absent for a remote Job: that list is this computer's. */
  hide?(paths: string[]): void
}

/** A read-only pairing's refusal says why in its own words (the door's reason); anything else is `fallback`. */
const failure = (reply: CommandReply, ui: ActionUi, fallback: string): void => {
  const body = reply.body as { code?: unknown; error?: unknown } | null
  if (body?.code === 'RUNTIME_PERMISSION_DENIED' && typeof body.error === 'string') ui.error(body.error)
  else ui.error(fallback)
}

/** Sends, and shows a failure; a send that throws (IPC) is the same failure. Answers the reply, or null. */
const send = async (door: OrchDoor, cmd: string, args: Record<string, unknown>, ui: ActionUi, fallback: string): Promise<CommandReply | null> => {
  try {
    return await door.command(cmd, args)
  } catch {
    ui.error(fallback)
    return null
  }
}

/** Pauses a schedule, after asking. A worker someone holds (worker-retain) is said apart from other refusals. */
export async function pauseRun(door: OrchDoor, runId: string, ui: ActionUi): Promise<void> {
  const ok = await ui.confirm({ title: ui.t('jobs.run.pauseConfirmTitle'), body: ui.t('jobs.run.pauseConfirmBody'), confirmLabel: ui.t('jobs.run.pause') })
  if (!ok) return
  const reply = await send(door, 'run-pause', { run: runId }, ui, ui.t('jobs.run.pauseFailed'))
  if (!reply || reply.status < 400) return
  if (reply.status === 409) ui.error(JSON.stringify(reply.body).includes('worker-retain') ? ui.t('jobs.run.pauseRetained') : ui.t('jobs.run.pauseFailed'))
  else failure(reply, ui, ui.t('jobs.run.pauseFailed'))
}

export async function resumeRun(door: OrchDoor, runId: string, ui: ActionUi): Promise<void> {
  const reply = await send(door, 'run-resume', { run: runId }, ui, ui.t('jobs.run.pauseFailed'))
  if (reply && reply.status >= 400) failure(reply, ui, ui.t('jobs.run.pauseFailed'))
}

/** Puts a coordinator back on a Run that lost it: `run-start` again, whose meaning is "this Run has a manager" and
 *  which does nothing when it has one (command.ts). The row's id is a Job's or a round's; run-start takes both. */
export async function restartCoordinator(door: OrchDoor, runId: string, ui: ActionUi): Promise<void> {
  const reply = await send(door, 'run-start', { run: runId }, ui, ui.t('jobs.run.coordinatorRestartFailed'))
  if (reply && reply.status >= 400) failure(reply, ui, ui.t('jobs.run.coordinatorRestartFailed'))
}

/** Deletes a Run after a confirmation that counts what goes with it (a schedule's rounds too) and offers to merge
 *  and to remove the worktrees it used. Irreversible, so the counts never understate. */
export async function deleteRun(door: OrchDoor, snapshot: OrchSnapshot | null, runId: string, ui: ActionUi): Promise<void> {
  // findRun: a round is not among the top-level runs (snapshot.ts).
  const run = snapshot ? findRun(snapshot, runId) : undefined
  if (!run) return
  // A template's rounds go with it (run-delete deletes them in the same set), so they are counted.
  const kids = run.children ?? []
  const tasks = kids.reduce((n, k) => n + k.total, run.total)
  const events = kids.reduce((n, k) => n + k.eventCount, run.eventCount)
  // Workers that will be stopped: Tasks with an open Dispatch, not runningCount (validating and reviewing have no
  // session to end).
  const workers = [run, ...kids].reduce((n, r) => n + r.tasks.filter((tk) => tk.startedAt !== undefined).length, 0)
  // Only a Run that used worktrees gets the choices; a template counts its rounds' folders, since it ran none itself.
  const wt = run.schedule ? kids.flatMap((k) => k.worktrees ?? []) : (run.worktrees ?? [])
  const answer = await ui.confirmChoices({
    title: ui.t('jobs.run.delete'),
    // Only deleting a template stops workers (run-delete): what goes with it is said here.
    body:
      ui.t('jobs.run.deleteBody', { objective: run.objective, tasks, events }) +
      (run.schedule && workers > 0 ? '\n\n' + ui.t('jobs.run.deleteStopsWorkers', { workers }) : ''),
    confirmLabel: ui.t('jobs.run.delete'),
    ...(wt.length > 0
      ? {
          choices: [
            { id: 'merge', label: ui.t('jobs.run.deleteMerge'), hint: ui.t('jobs.run.deleteMergeHint', { count: wt.length }) },
            ...(ui.hide ? [{ id: 'hide', label: ui.t('jobs.run.deleteHide') }] : []),
            // Removing without merging loses the unmerged commits then: said always, at the moment of choosing.
            { id: 'worktrees', label: ui.t('jobs.run.deleteWorktrees', { count: wt.length }), hint: ui.t('jobs.run.deleteWorktreesHint') }
          ]
        }
      : {})
  })
  if (!answer.ok) return
  const reply = await send(
    door,
    'run-delete',
    {
      id: runId,
      ...(answer.checked.includes('merge') ? { merge: true } : {}),
      ...(answer.checked.includes('worktrees') ? { removeWorktrees: true } : {})
    },
    ui,
    ui.t('jobs.run.deleteFailed')
  )
  if (!reply) return
  // Hiding is the renderer's own list, and only after the delete went through: a refused delete (a running worker
  // answers 409, a common path) must not leave the history hidden with nothing deleted.
  if (reply.status < 400 && answer.checked.includes('hide')) ui.hide?.(wt)
  // The two 409s are told apart by our own server's sentences: a held session is released, not stopped.
  if (reply.status === 409) ui.error(JSON.stringify(reply.body).includes('worker-retain') ? ui.t('jobs.run.deleteRetained') : ui.t('jobs.run.deleteBusy'))
  else if (reply.status >= 400) failure(reply, ui, ui.t('jobs.run.deleteFailed'))
  else {
    // Folders the command kept (uncommitted changes after a merge, or a state it could not read) are said, in a
    // notice that stays.
    const kept = (reply.body as { worktreesKept?: unknown } | null)?.worktreesKept
    if (Array.isArray(kept) && kept.length > 0) ui.error(ui.t('jobs.run.deleteKeptWorktrees', { count: kept.length }))
  }
}

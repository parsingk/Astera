import type { Message } from '../../../core/i18n'

/** How the running sessions divide when this app process ends, given how many of them the Host owns.
 *
 *  Both dialogs that ask a person to end the app face the same three-way split, because both end it
 *  the same way: the close button on Linux, and installing an update. Only the sentences differ.
 *
 *  The two numbers come from different processes at different moments — the renderer's last render
 *  and main's answer at click time — so a session spawned in between can make `kept` the larger.
 *  Reading that as "all of them" keeps `ended` from going negative; the alternative, believing the
 *  stale figure, would tell the person a session is ending when none is. */
type QuitSplit =
  | { kind: 'allKept'; count: number }
  | { kind: 'noneKept'; count: number }
  | { kind: 'mixed'; kept: number; ended: number }

function splitOnQuit(running: number, kept: number): QuitSplit {
  if (kept >= running) return { kind: 'allKept', count: running }
  if (kept <= 0) return { kind: 'noneKept', count: running }
  return { kind: 'mixed', kept, ended: running - kept }
}

/** What the window-close confirmation should say quitting costs, given how many sessions are running
 *  and how many of those the Host owns. The caller translates it with useI18n().t, the same way
 *  `worktreeErrorMessage` hands one back.
 *
 *  **Three sentences, not two.** The dialog used to ask whether a Host was installed and pick between
 *  "everything is terminated" and "everything comes back". The Host takes a moment to start, so a
 *  session spawned at boot is the app's own child while a later one belongs to the Host — and then
 *  both of those sentences are wrong at once, each about the half of the sessions it does not
 *  describe. The condition here is the same one `will-quit` acts on, counted rather than assumed:
 *  main answers with the number of running sessions whose ptys outlive the app.
 *
 *  Linux only today (App.tsx's closeWindow), because that is the one platform where closing the
 *  window really quits. That changes when the sentence is shown, not what it should say.
 *
 *  A pure function because App.tsx is not reachable by a test, and this is the exact place a
 *  reassuring sentence could be shown over sessions that are about to be killed. */
export function quitConfirmBody(running: number, kept: number): Message {
  const split = splitOnQuit(running, kept)
  if (split.kind === 'allKept') return { key: 'common.quitConfirm.bodyKept', params: { count: split.count } }
  if (split.kind === 'noneKept') return { key: 'common.quitConfirm.body', params: { count: split.count } }
  return { key: 'common.quitConfirm.bodyMixed', params: { kept: split.kept, ended: split.ended } }
}

/** The same question for installing an update, which quits the app immediately and starts the new
 *  version in its place.
 *
 *  **Why this is no longer the close dialog's sentence with a different title.** The old text said
 *  every running session would be terminated. Since the Host that is the reason for this branch, the
 *  sessions it owns are not killed by the app quitting — they keep running through the install and
 *  the new version takes them back.
 *
 *  **And why it does not promise they come back, the way the close dialog does.** Which is the one
 *  thing this app cannot find out: a Host from an older protocol is retired by the app that finds it,
 *  and only the incoming version knows whether its protocol has moved. So the two halves of what is
 *  knowable are said separately — these sessions outlive the quit, and whether the update keeps them
 *  is the update's to answer. Anything more certain in either direction would be invented here.
 *
 *  A person quitting through the window close button on Linux gets `quitConfirmBody` instead, and no
 *  such caveat, because nothing is being replaced there. */
export function updateConfirmBody(running: number, kept: number): Message {
  const split = splitOnQuit(running, kept)
  if (split.kind === 'allKept') return { key: 'update.confirm.bodyKept', params: { count: split.count } }
  // Unchanged from before the Host existed, and still exactly true when it owns none of them.
  if (split.kind === 'noneKept') return { key: 'update.confirm.body', params: { count: split.count } }
  return { key: 'update.confirm.bodyMixed', params: { kept: split.kept, ended: split.ended } }
}

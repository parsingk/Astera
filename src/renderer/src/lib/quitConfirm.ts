import type { Message } from '../../../core/i18n'

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
  // The two numbers come from different processes at different moments — the renderer's last render
  // and main's answer at click time — so a session spawned in between can make kept the larger.
  // Reading that as "all of them" keeps `ended` from going negative; the alternative, believing the
  // stale figure, would tell the person a session is ending when none is.
  if (kept >= running) return { key: 'common.quitConfirm.bodyKept', params: { count: running } }
  if (kept <= 0) return { key: 'common.quitConfirm.body', params: { count: running } }
  return { key: 'common.quitConfirm.bodyMixed', params: { kept, ended: running - kept } }
}

// The Jobs sidebar push ('orch:state'), out of ipc.ts so its rules can be tested (ipc.ts imports electron).
//
// Performance audit M1: the push hangs off every orchestration commit, and a worker's heartbeat, a Delivery and a
// status message are each a commit. Folding the project and serializing both the new fold and the last one sent on
// each of them is what kept main busy while a Job ran. So:
// - a burst of commits in one tick folds once, for the newest state (the renderer only ever shows the newest);
// - the last sent snapshot is kept as its string, made once when it is sent rather than again for every compare.
// The compare is still the serialized one `sameSnapshot` documents (core/orchestration/view.ts), and sound for the
// same reason: both sides come out of snapshotFor.
import type { OrchState } from '../core/orchestration/state'
import type { OrchSnapshot } from '../core/types'

export interface OrchPushDeps {
  fold(state: OrchState, project: string): OrchSnapshot
  send(snapshot: OrchSnapshot): void
  log(line: string): void
  /** Defaults to setImmediate: after the commit that pushed, before the next I/O. */
  schedule?: (fn: () => void) => void
}

export interface OrchPush {
  /** A commit landed. Folded later in this tick, with whatever state is newest by then. */
  push(state: OrchState): void
  /** The renderer asked for this project and now holds `sent` (orch.list's reply). */
  watch(project: string, sent: OrchSnapshot): void
  /** The renderer stopped asking (orch.unwatch); a push already queued sends nothing. */
  unwatch(): void
  project(): string | null
  /** The last state pushed, for a re-push after a worktree presence answer. */
  lastPushed(): OrchState | null
}

export function createOrchPush(d: OrchPushDeps): OrchPush {
  const schedule = d.schedule ?? ((fn: () => void): void => void setImmediate(fn))
  let project: string | null = null
  let sentKey: string | null = null
  let last: OrchState | null = null
  let queued = false
  const flush = (): void => {
    queued = false
    if (project === null || last === null) return
    // The push used to run inside the awaited setState, so a throw would reject a write already persisted; it runs
    // later now, and a throw would only end this tick. Logged either way: a fold that throws is a real defect.
    try {
      const next = d.fold(last, project)
      const key = JSON.stringify(next)
      if (key === sentKey) return
      sentKey = key
      d.send(next)
    } catch (err) {
      d.log(`orch:state push failed project=${project}: ${String(err)}`)
    }
  }
  return {
    push: (state) => {
      last = state
      if (project === null || queued) return
      queued = true
      schedule(flush)
    },
    watch: (p, sent) => {
      project = p
      sentKey = JSON.stringify(sent)
    },
    unwatch: () => {
      project = null
      sentKey = null
    },
    project: () => project,
    lastPushed: () => last
  }
}

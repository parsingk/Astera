/** Worktree creation notification bus. When NewSessionDialog's "start in a separate worktree" option makes
 *  spawn() in App.tsx call worktrees.create and it succeeds, the result is announced on this bus and
 *  WorktreePanel, which subscribes, re-queries its list.
 *  The same module-singleton pattern as toast.ts and confirm.ts (Set<listener> + emit) — sessionBus is a
 *  keyed stream that buffers per session id, which does not fit this "something was created" broadcast, so
 *  it is not reused and this is kept separate. */

const listeners = new Set<() => void>()

export function notifyCreated(): void {
  for (const listener of listeners) listener()
}

export function subscribeCreated(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

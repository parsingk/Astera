// The Tasks whose lost-worker Gate is being opened right now (Phase 3R minor): the driving's `gateLost` and the Host
// recovery's Gate for an attempt the journal never saw are two doors to the same `gate-create`, and each awaits it.
// A Task one of them has claimed is skipped by the other until the claim is released, so two Gates are never asked for.
export interface LostGateGuard {
  /** True when this caller now holds the Task; false when another does. */
  claim(taskId: string): boolean
  release(taskId: string): void
}

export function createLostGateGuard(): LostGateGuard {
  const held = new Set<string>()
  return {
    claim: (taskId) => {
      if (held.has(taskId)) return false
      held.add(taskId)
      return true
    },
    release: (taskId) => {
      held.delete(taskId)
    }
  }
}

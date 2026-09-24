// Mirrors the Host's own merges into this app's Work Unit tracking (host S3 ruling R7, §3.3): a merge
// the Host runs is registered here the same way one this app runs itself already is, so the Work Unit
// screen does not read the HEAD move `git-op` announces as a change from outside.
import type { HostMessage } from '../../core/host/protocol'

export function createHostGitOps(collector: {
  beginGitOperation(kind: 'job-merge', cwd: string): string
  endGitOperation(id: string): void
}): {
  pushed(m: HostMessage): void
  hostGone(): void
} {
  // The Host's own op id → this app's local registration for it, so `end` closes the same one
  // `begin` opened.
  const open = new Map<string, string>()

  return {
    pushed: (m) => {
      if (m.t !== 'git-op') return
      if (m.kind !== 'job-merge') return // not a kind this app knows — nothing to register
      if (m.phase === 'begin') {
        // M4 (fix round 1): a repeated begin for the same op must not leak the first registration —
        // op ids are unique per Host life, so this should not happen, but overwriting the Map entry
        // without ending it first would leave a Work Unit operation open forever (isAsteraOperation
        // reads one with no endedAt as still running), silently swallowing every outside change in
        // that project for the rest of this process's life.
        const prev = open.get(m.op)
        if (prev !== undefined) collector.endGitOperation(prev)
        open.set(m.op, collector.beginGitOperation(m.kind, m.cwd))
        return
      }
      // phase 'end'
      const id = open.get(m.op)
      if (id === undefined) return // an end this app never saw begin
      open.delete(m.op)
      collector.endGitOperation(id)
    },
    // §3.3: a Host that dies between begin and end must not leave the Work Unit screen believing a
    // merge is still running forever.
    hostGone: () => {
      for (const id of open.values()) collector.endGitOperation(id)
      open.clear()
    }
  }
}

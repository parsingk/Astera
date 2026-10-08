// The open remote session tabs, kept current from their Runtimes (remote runtime design Phase 9b, N13, X1-11): each
// Runtime with an open tab is asked for its sessions, and each open tab for its facts, every few seconds. A row that
// changed updates its tab (ended, renamed, a new pty), a roll moves the tab to the session that replaced it, and a
// session that began waiting is reported for a notification. Polled, not pushed (ledger ruling): the Host's facts are
// read on demand there.
import { useEffect, useRef } from 'react'
import { factsStatus, factsTransition, followRolls, pruneBaseline, readFacts, refOf, remoteCall, type RemoteFacts, type RemoteSessionRef, type RemoteSessionRow } from '../lib/remoteSessions'

export const REMOTE_WATCH_MS = 3_000

const sameRef = (a: RemoteSessionRef, b: RemoteSessionRef): boolean =>
  a.alive === b.alive && a.title === b.title && a.ptyId === b.ptyId && a.procId === b.procId && a.cwd === b.cwd

export function useRemoteSessionWatch(o: {
  refs: RemoteSessionRef[]
  onUpdate(ref: RemoteSessionRef): void
  onFollow(fromKey: string, to: RemoteSessionRef): void
  onStatus(key: string, status: RemoteFacts['status']): void
  onWaiting(ref: RemoteSessionRef, facts: RemoteFacts): void
}): void {
  const latest = useRef(o)
  latest.current = o
  const any = o.refs.length > 0

  useEffect(() => {
    if (!any) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    /** The last facts per tab: the first read is a baseline, so opening a waiting session does not notify. */
    const last = new Map<string, RemoteFacts>()
    const tick = async (): Promise<void> => {
      const { refs } = latest.current
      pruneBaseline(last, refs.map((r) => r.key))
      const byRuntime = new Map<string, RemoteSessionRef[]>()
      for (const r of refs) byRuntime.set(r.runtimeId, [...(byRuntime.get(r.runtimeId) ?? []), r])
      await Promise.all(
        [...byRuntime].map(async ([runtimeId, open]) => {
          const list = await remoteCall(runtimeId, 'sessions-list', {})
          if (stopped || list.status !== 200 || !Array.isArray(list.body)) return
          const rows = list.body as RemoteSessionRow[]
          for (const ref of open) {
            const row = rows.find((x) => x.id === ref.sessionId)
            if (row) {
              const next = refOf(runtimeId, row)
              if (!sameRef(ref, next)) latest.current.onUpdate(next)
            }
          }
          for (const f of followRolls(open, rows)) latest.current.onFollow(f.from, f.to)
        })
      )
      await Promise.all(
        refs.map(async (ref) => {
          const r = await readFacts(ref.runtimeId, ref.sessionId).catch(() => ({ status: 0, body: null }))
          if (stopped) return
          // Not read: the tab stops showing its last status as current (review I1).
          latest.current.onStatus(ref.key, factsStatus(r))
          if (r.status !== 200) return
          const facts = r.body as RemoteFacts
          if (factsTransition(last.get(ref.key) ?? null, facts) === 'waiting') latest.current.onWaiting(ref, facts)
          last.set(ref.key, facts)
        })
      )
      if (!stopped) timer = setTimeout(() => void tick(), REMOTE_WATCH_MS)
    }
    void tick()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [any])
}

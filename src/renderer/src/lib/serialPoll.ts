// A poll with one request in flight at most (remote runtime design Phase 6, review C1). The next request starts only
// after the last one answered, plus the interval: a Runtime that takes longer than the interval to answer (a dropped
// route waits out the connect timeout) still has its answer drawn, since no newer request overtook it.
// `after`: a request of the poll this one replaces that may still be in flight; the first request waits for it to settle.
export function startSerialPoll(ask: () => Promise<unknown>, intervalMs: number, o: { paused?: () => boolean; after?: Promise<unknown> } = {}): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const run = (): void => {
    if (stopped) return
    // Paused (a hidden window): nothing is asked, and the next turn looks again.
    if (o.paused?.()) {
      timer = setTimeout(run, intervalMs)
      return
    }
    void ask()
      .catch(() => {})
      .finally(() => {
        if (!stopped) timer = setTimeout(run, intervalMs)
      })
  }
  if (o.after) void o.after.catch(() => {}).then(run)
  else run()
  return () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
  }
}

// Stale-answer guards for reads a view makes again before the last one answered (audit UI-6, UI-8).

/** Tickets in order: an answer is applied only while its ticket is the newest one handed out. */
export function createLatest(): { next(): number; isCurrent(ticket: number): boolean } {
  let n = 0
  return {
    next: () => ++n,
    isCurrent: (ticket) => ticket === n
  }
}

/** `read` for every id, the answers that came keyed by id; a failed one is left out instead of failing them all. */
export async function settledPairs<T>(ids: readonly string[], read: (id: string) => Promise<T>): Promise<Record<string, T>> {
  const settled = await Promise.allSettled(ids.map(async (id) => [id, await read(id)] as const))
  const out: Record<string, T> = {}
  for (const r of settled) if (r.status === 'fulfilled') out[r.value[0]] = r.value[1]
  return out
}

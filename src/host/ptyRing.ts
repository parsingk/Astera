// The pty ring (remote runtime design §3.7, N1, X1-10). Every pty event (an output chunk, a resize, the exit) gets the
// next seq and is kept in order in a bounded ring that replaces the old string tail. The bound is the tail's
// (SCROLLBACK_CHARS UTF-16 units) plus RING_EVENT_COST per event, so many tiny events cannot exceed it. A chunk over
// RING_CHUNK_MAX is split into ordered pieces at UTF-16 boundaries; a replay always delivers a contiguous run of
// events, so the pieces join back exactly where they were cut.
//
// Imports nothing: the Host bundles this file.

export type PtyEvent =
  | { seq: number; kind: 'data'; data: string }
  | { seq: number; kind: 'resize'; cols: number; rows: number }
  | { seq: number; kind: 'exit'; code: number | null }

export type PtyEventInput =
  | { kind: 'data'; data: string }
  | { kind: 'resize'; cols: number; rows: number }
  | { kind: 'exit'; code: number | null }

/** What one event costs beyond its text: many tiny events count, so they cannot outgrow the bound (X1-10). */
export const RING_EVENT_COST = 64
/** The longest data event, in UTF-16 units. */
export const RING_CHUNK_MAX = 65_536
/** Today's tail bound (registry.ts SCROLLBACK_CHARS), the ring's default. */
const DEFAULT_BOUND = 256_000

export interface PtyRing {
  /** Appends, splitting data over RING_CHUNK_MAX; answers the events made, with their seqs. */
  push(e: PtyEventInput): PtyEvent[]
  /** The events from `fromSeq` on, or null when the ring no longer holds `fromSeq` or it is past the next seq. */
  since(fromSeq: number): PtyEvent[] | null
  /** The oldest seq held (lastSeq + 1 when empty). */
  firstSeq(): number
  /** The newest seq given, 0 before any. */
  lastSeq(): number
  cost(): number
  /** The data events joined, in order: the attach replay a client without seq gets (today's tail). */
  text(): string
}

const costOf = (e: PtyEvent): number => (e.kind === 'data' ? e.data.length : 0) + RING_EVENT_COST

/** Cuts `data` into pieces of at most RING_CHUNK_MAX units, never between a high and a low surrogate. */
function pieces(data: string): string[] {
  if (data.length <= RING_CHUNK_MAX) return [data]
  const out: string[] = []
  let at = 0
  while (at < data.length) {
    let end = Math.min(at + RING_CHUNK_MAX, data.length)
    const before = data.charCodeAt(end - 1)
    if (end < data.length && before >= 0xd800 && before <= 0xdbff) end -= 1
    out.push(data.slice(at, end))
    at = end
  }
  return out
}

export function createPtyRing(o: { bound?: number } = {}): PtyRing {
  const bound = Math.max(1, o.bound ?? DEFAULT_BOUND)
  let events: PtyEvent[] = []
  let head = 0
  let seq = 0
  let cost = 0

  const add = (e: PtyEvent): void => {
    events.push(e)
    cost += costOf(e)
    // The newest event always stays, even alone over the bound: dropping it would lose output nobody has seen.
    while (cost > bound && events.length - head > 1) cost -= costOf(events[head++])
    if (head > 1024 && head * 2 > events.length) {
      events = events.slice(head)
      head = 0
    }
  }

  const held = (): PtyEvent[] => events.slice(head)

  return {
    push: (e) => {
      const made: PtyEvent[] =
        e.kind === 'data' ? pieces(e.data).map((data) => ({ seq: ++seq, kind: 'data' as const, data })) : [{ ...e, seq: ++seq } as PtyEvent]
      for (const m of made) add(m)
      return made
    },
    since: (fromSeq) => {
      const first = head < events.length ? events[head].seq : seq + 1
      if (!Number.isInteger(fromSeq) || fromSeq < first || fromSeq > seq + 1) return null
      return events.slice(head + (fromSeq - first))
    },
    firstSeq: () => (head < events.length ? events[head].seq : seq + 1),
    lastSeq: () => seq,
    cost: () => cost,
    text: () => held().map((e) => (e.kind === 'data' ? e.data : '')).join('')
  }
}

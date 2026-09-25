// The block records that travel between the app and the Host (S6 plan D3, D4). Both processes keep one
// BlockRegistry; each sends its own changes and absorbs the other's. Shared here so the two sides read
// and apply a `blocks` message by one rule.
//
// No I/O. A message from the other process is untrusted input (R3): parseBlocks never throws and keeps
// only well formed entries, so a handler that calls it cannot be thrown out of by a bad line.
import type { BlockChangeEvent, BlockRegistry, BlocksPayload } from './blockRegistry'
import type { BlockRecord } from './retry'

/** One onChange event as the payload that carries it. */
export function blocksOfChange(e: BlockChangeEvent): BlocksPayload {
  return e.rec ? { records: { [e.accountId]: e.rec }, cleared: [] } : { records: {}, cleared: [{ accountId: e.accountId, at: e.at }] }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function recordOf(v: unknown): BlockRecord | null {
  if (!isObject(v)) return null
  const { at, weekly, since } = v
  if (!(at === null || finite(at)) || typeof weekly !== 'boolean' || !finite(since)) return null
  // A clean copy: nothing but the three fields reaches the registry.
  return { at, weekly, since }
}

/** Reads a `blocks` message (either direction). Null when it is not an object at all; otherwise the
 *  well formed entries, with a wrong-shaped `records` or `cleared` read as empty. */
export function parseBlocks(v: unknown): BlocksPayload | null {
  if (!isObject(v)) return null
  const records: Array<[string, BlockRecord]> = []
  if (isObject(v.records))
    for (const [id, raw] of Object.entries(v.records)) {
      const rec = recordOf(raw)
      if (id !== '' && rec) records.push([id, rec])
    }
  const cleared: BlocksPayload['cleared'] = []
  if (Array.isArray(v.cleared))
    for (const c of v.cleared)
      if (isObject(c) && typeof c.accountId === 'string' && c.accountId !== '' && finite(c.at)) cleared.push({ accountId: c.accountId, at: c.at })
  // fromEntries defines own properties, so an id like "__proto__" stays a plain key.
  return { records: Object.fromEntries(records), cleared }
}

/** Applies a payload from the other process without firing onChange (no echo back to it).
 *
 *  **Clears first**, so a record in the same payload that was made after its clear survives (absorb
 *  drops only a record whose `since` is at or before the clear). **A clear older than what this side
 *  recorded since is skipped:** it arrived late, and the block it would erase was observed after it. */
export function absorbBlocks(reg: BlockRegistry, p: BlocksPayload, now: number): void {
  for (const c of p.cleared) {
    const held = reg.get(c.accountId, now)
    if (held && held.since > c.at) continue
    reg.absorbClear(c.accountId, c.at)
  }
  for (const [id, rec] of Object.entries(p.records)) reg.absorb(id, rec, now)
}

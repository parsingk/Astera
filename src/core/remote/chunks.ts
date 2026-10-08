// Chunked replies (remote runtime design §3.1). A reply over CHUNK_THRESHOLD bytes of JSON goes as chunk frames, each
// carrying at most CHUNK_SIZE bytes as base64, so every frame stays under the 1 MiB frame cap whatever the text's
// encoding. The receiver puts them back in order and refuses a body over the reassembly cap.

export const CHUNK_THRESHOLD = 512 * 1024
export const CHUNK_SIZE = 512 * 1024
export const REASSEMBLED_CAP = 64 << 20

export interface ChunkFrame {
  t: 'chunk'
  ref: string
  i: number
  n: number
  data: string
}

export function chunksOf(ref: string, json: string): ChunkFrame[] {
  const bytes = Buffer.from(json, 'utf8')
  const n = Math.max(1, Math.ceil(bytes.length / CHUNK_SIZE))
  const out: ChunkFrame[] = []
  for (let i = 0; i < n; i++) out.push({ t: 'chunk', ref, i, n, data: bytes.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE).toString('base64') })
  return out
}

/** How long a reply whose chunks stopped coming is held, and how many are held at once (performance audit H7): its
 *  connection closed or its stream was dropped, and the rest will never come. */
export const REASSEMBLY_STALE_MS = 2 * 60_000
export const REASSEMBLY_MAX_OPEN = 16

/** Answers the whole JSON text when a ref completes, null while it is still arriving, or an error. A ref with no chunk
 *  for `staleMs`, or the oldest past `maxOpen`, is forgotten. */
export function createReassembler(
  o: { cap?: number; now?: () => number; staleMs?: number; maxOpen?: number } = {}
): { add(f: ChunkFrame): string | null | { error: string }; held(): number } {
  const cap = o.cap ?? REASSEMBLED_CAP
  const now = o.now ?? Date.now
  const staleMs = o.staleMs ?? REASSEMBLY_STALE_MS
  const maxOpen = o.maxOpen ?? REASSEMBLY_MAX_OPEN
  const open = new Map<string, { n: number; parts: Buffer[]; bytes: number; at: number }>()
  const forgetOld = (): void => {
    const t = now()
    for (const [ref, h] of open) if (t - h.at > staleMs) open.delete(ref)
    for (const ref of open.keys()) {
      if (open.size <= maxOpen) break
      open.delete(ref)
    }
  }
  return {
    held: () => open.size,
    add: (f) => {
      if (!Number.isInteger(f.n) || f.n < 1 || !Number.isInteger(f.i)) return { error: 'bad chunk' }
      forgetOld()
      let held = open.get(f.ref)
      if (!held) {
        if (f.i !== 0) return { error: 'chunk out of order' }
        held = { n: f.n, parts: [], bytes: 0, at: now() }
        open.set(f.ref, held)
        forgetOld()
      }
      held.at = now()
      if (f.n !== held.n || f.i !== held.parts.length) {
        open.delete(f.ref)
        return { error: 'chunk out of order' }
      }
      const part = Buffer.from(f.data, 'base64')
      held.bytes += part.length
      if (held.bytes > cap) {
        open.delete(f.ref)
        return { error: 'REMOTE_REPLY_TOO_LARGE' }
      }
      held.parts.push(part)
      if (held.parts.length < held.n) return null
      open.delete(f.ref)
      return Buffer.concat(held.parts).toString('utf8')
    }
  }
}

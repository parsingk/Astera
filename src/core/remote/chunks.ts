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

/** Answers the whole JSON text when a ref completes, null while it is still arriving, or an error. */
export function createReassembler(o: { cap?: number } = {}): { add(f: ChunkFrame): string | null | { error: string } } {
  const cap = o.cap ?? REASSEMBLED_CAP
  const open = new Map<string, { n: number; parts: Buffer[]; bytes: number }>()
  return {
    add: (f) => {
      if (!Number.isInteger(f.n) || f.n < 1 || !Number.isInteger(f.i)) return { error: 'bad chunk' }
      let held = open.get(f.ref)
      if (!held) {
        if (f.i !== 0) return { error: 'chunk out of order' }
        held = { n: f.n, parts: [], bytes: 0 }
        open.set(f.ref, held)
      }
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

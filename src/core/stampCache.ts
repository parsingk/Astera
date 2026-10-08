// The last value read from a file, kept while the file's modification time and size stay the same (audit U-3, U-11).
// A whole-store read and parse on every list or checkpoint cost the file's size each time though nothing had changed.
// A stat that fails reads again; a read that fails is not kept.
import { promises as fs, statSync } from 'node:fs'

const stampOf = (st: { mtimeMs: number; size: number }): string => `${st.mtimeMs}:${st.size}`

export function cachedByStamp<T>(file: string, read: () => Promise<T>): () => Promise<T> {
  let last: { stamp: string; value: T } | null = null
  return async () => {
    const stamp = await fs.stat(file).then(stampOf, () => null)
    if (stamp !== null && last?.stamp === stamp) return last.value
    const value = await read()
    last = stamp === null ? null : { stamp, value }
    return value
  }
}

export function cachedByStampSync<T>(file: string, read: () => T): () => T {
  let last: { stamp: string; value: T } | null = null
  return () => {
    let stamp: string | null = null
    try {
      stamp = stampOf(statSync(file))
    } catch {
      stamp = null
    }
    if (stamp !== null && last?.stamp === stamp) return last.value
    const value = read()
    last = stamp === null ? null : { stamp, value }
    return value
  }
}

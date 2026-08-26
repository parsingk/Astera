// Bounded read of the end of a jsonl file. Lifted out of limitProbe.ts once CodexRolloutTail needed
// the same thing (seeding the reset time a resumed session cannot see) — two copies of a reader whose
// correctness rests on the short-read and cut-line rules below would drift.
import { open } from 'node:fs/promises'

export const TAIL_CAP = 512 * 1024 // the maximum number of bytes to read from the end

/** Reads at most cap bytes from the end of the file and returns the complete lines.
 *  The first line, which the cap boundary may have cut off at the front, is dropped — parsing half a
 *  JSON object is meaningless.
 *  A failure of **the read itself** (a missing file, a permission error and so on) gives `null` — kept
 *  distinct from the case where the file was read but has no complete lines ([]). This is the same
 *  convention as `JsonlTail.read()`: null means missing or errored, [] means no new lines.
 *  The caller has to log the null, otherwise failures disappear without a trace.
 *
 *  Why not read the whole thing: a claude transcript measured up to 37MB. Reading that on the Electron
 *  main thread and running split and JSON.parse over it freezes the UI for seconds (the same reason as in
 *  claudeSignal.ts). The limit entry that ended the session is by definition at the end of the file, so a
 *  bounded read from the end is enough. */
export async function tailLines(filePath: string, cap = TAIL_CAP): Promise<string[] | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(filePath, 'r')
    const { size } = await handle.stat()
    const start = Math.max(0, size - cap)
    const length = size - start
    if (length <= 0) return [] // an empty file — the read succeeded, this is not a failure
    const buffer = Buffer.alloc(length)
    // bytesRead is honoured — on a short read (rare but possible) the tail of the buffer is left holding
    // uninitialised zero bytes, which breaks JSON.parse on the last line, the very line that may hold the
    // limit entry.
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
    // If start === 0 (the file is smaller than cap) the first line is intact, so it is kept. If start > 0
    // it may have been cut at the cap boundary, so it is dropped — miss this branch and a small file's only
    // entry is lost.
    if (start > 0) lines.shift()
    return lines.filter((l) => l.trim() !== '')
  } catch {
    return null // open, stat or read failed — missing, permissions, EBUSY and so on. The caller has to log it.
  } finally {
    try {
      await handle?.close()
    } catch {
      /* a failure cleaning up the fd is ignored */
    }
  }
}

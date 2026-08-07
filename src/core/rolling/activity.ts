// Session activity signals used for blind-spot detection. The main transcript does not record
// subagent activity in real time, so we look at the mtime of the subagent file tree together with the
// pendingWorkflowCount of the last turn_duration. Like transcript.ts, this uses node:fs directly from
// core — main (rolling.ts) uses it as the default for injected deps, and tests inject fakes.
import { promises as fs } from 'node:fs'
import path from 'node:path'

const TAIL_BYTES = 64 * 1024 // turn_duration is recorded every turn, so a 64KB tail is enough

/** Latest mtime (ms) of the transcript file plus the subagent tree (<directory>/<sessionId>/**).
 *  On Windows a directory mtime does not change when content is appended, so we stat per file.
 *  Individual failures are ignored; null if nothing could be read at all. */
export async function lastActivityAt(transcriptPath: string): Promise<number | null> {
  let max: number | null = null
  const consider = (m: number): void => {
    if (max === null || m > max) max = m
  }
  try {
    consider((await fs.stat(transcriptPath)).mtimeMs)
  } catch {
    /* transcript access failed — fall back to the subagent tree */
  }
  const sessionDir = path.join(path.dirname(transcriptPath), path.basename(transcriptPath, '.jsonl'))
  await walk(sessionDir, consider)
  return max
}

const MAX_WALK_DEPTH = 8 // the subagent tree is around 4 levels deep — a ceiling guarding against abnormal trees and symlink cycles

async function walk(dir: string, consider: (m: number) => void, depth = 0): Promise<void> {
  if (depth > MAX_WALK_DEPTH) return // guard against symlink cycles / abnormal depth
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return // directory absent (no subagents used) — ignore
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) await walk(p, consider, depth + 1)
    else {
      try {
        consider((await fs.stat(p)).mtimeMs)
      } catch {
        /* ignore individual stat failures */
      }
    }
  }
}

/** pendingWorkflowCount of the last turn_duration entry in the transcript tail text.
 *  null if there is no such entry or the field is missing — the caller treats null/0 as "no background
 *  work" and does not intervene. */
export function parsePendingWorkflowCount(tail: string): number | null {
  let result: number | null = null
  for (const line of tail.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    try {
      const d = JSON.parse(t) as { type?: unknown; subtype?: unknown; pendingWorkflowCount?: unknown }
      if (d.type === 'system' && d.subtype === 'turn_duration')
        result = typeof d.pendingWorkflowCount === 'number' ? d.pendingWorkflowCount : null
    } catch {
      /* ignore a truncated tail and non-JSON lines */
    }
  }
  return result
}

/** Reads only the last 64KB of the file and applies parsePendingWorkflowCount (safe for large transcripts). null on failure. */
export async function readPendingWorkflowCount(transcriptPath: string): Promise<number | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(transcriptPath, 'r')
    const size = (await handle.stat()).size
    const start = Math.max(0, size - TAIL_BYTES)
    const length = size - start
    if (length <= 0) return null
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    return parsePendingWorkflowCount(buffer.toString('utf8'))
  } catch {
    return null
  } finally {
    try {
      await handle?.close()
    } catch {
      /* ignore fd cleanup failures */
    }
  }
}

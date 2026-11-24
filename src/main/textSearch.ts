import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { FileIndex } from './fileIndex'
import {
  isCredentialFile,
  looksBinary,
  matchLines,
  textSearchPattern,
  type TextMatch,
  type TextSearchAnswer
} from '../core/files/textMatch'

/** How many lines one search lists. Past a screen or two a person types more rather than scrolls a palette. */
export const TEXT_SEARCH_ROWS = 300

/** The largest file read: the editor's own cap (files.read opens a larger file cut at this size), so a match past it is
 *  one the editor could not show. A file this big that matters is a log or a bundle, not what a search looks for. */
export const TEXT_SEARCH_MAX_FILE_BYTES = 1024 * 1024

/** The longest query searched: what the palette's file list takes too. */
const MAX_QUERY = 256

/** How many files are read at once: enough to keep the disk busy, few enough that one search does not hold every
 *  libuv thread the rest of main needs. */
const READ_CONCURRENCY = 8

/** How long an ask waits for its search before answering with the rows so far. A small project finishes inside it, so
 *  its answer comes in one round trip; a large one answers with what is found and is asked again. */
const GRACE_MS = 100

export interface TextSearchDeps {
  /** The project file list Quick Open and the composer's `@` read (main/fileIndex.ts), keyed by the root string. */
  index: Pick<FileIndex, 'list' | 'expire'>
  /** The files IPC's path guard: resolves for a session's folder, a registered worktree or a known project, and for
   *  anything below one; rejects everything else. */
  allowedRoot: (p: string) => Promise<string>
  lstat?: (abs: string) => Promise<{ isFile(): boolean; size: number }>
  /** At most `max` bytes from the start of the file. */
  readUpTo?: (abs: string, max: number) => Promise<Buffer>
  concurrency?: number
  graceMs?: number
}

interface Run {
  root: string
  query: string
  matches: TextMatch[]
  done: boolean
  /** Superseded, cancelled or full: the readers stop at their next file. */
  halt: boolean
  truncated: boolean
  partial: boolean
  unavailable: boolean
  finished: Promise<void>
}

async function readUpToDefault(abs: string, max: number): Promise<Buffer> {
  const fh = await fs.open(abs, 'r')
  try {
    const buf = Buffer.alloc(max)
    let got = 0
    while (got < max) {
      const { bytesRead } = await fh.read(buf, got, max - got, got)
      if (bytesRead === 0) break
      got += bytesRead
    }
    return buf.subarray(0, got)
  } finally {
    await fh.close()
  }
}

/**
 * Text search's question to main: which lines of the files under this project hold what was typed (spec W2, audit §8
 * item 5).
 *
 * It reads the files the project index lists, so its scope is Quick Open's: the project's .gitignore and .ignore, the
 * folders that are never source, the same cap on a very large project (`partial` then). Of those it skips credential
 * files by name (never even looked at), anything that is not a regular file (a link could lead out of the project),
 * files over the editor's size cap, and binaries. Rows come as files are read, in the index's order give or take the
 * files in flight, and stop at TEXT_SEARCH_ROWS (`truncated` only when a further line really matches).
 *
 * One search per renderer (`owner`, the sender's id). Asking again with the same root and query answers its progress;
 * a different one stops it and starts anew; an empty or blank query stops it and answers nothing. So a search the
 * person has typed past never overwrites the newer one, and closing the box stops the reading. `refresh` (true) is the
 * box's first ask: the project is walked again before it is listed, as Quick Open does, because the explorer's watcher
 * keeps the list current only while the explorer is open.
 */
export function createTextSearch(
  deps: TextSearchDeps
): (owner: number, root: unknown, query: unknown, refresh?: unknown) => Promise<TextSearchAnswer> {
  const lstat = deps.lstat ?? ((abs: string) => fs.lstat(abs))
  const readUpTo = deps.readUpTo ?? readUpToDefault
  const concurrency = deps.concurrency ?? READ_CONCURRENCY
  const graceMs = deps.graceMs ?? GRACE_MS
  const runs = new Map<number, Run>()

  const stop = (owner: number): void => {
    const run = runs.get(owner)
    if (!run) return
    run.halt = true
    runs.delete(owner)
  }

  /** The text of a file worth searching, or null. Bounded by what lstat said, so a file growing as it is read (a log)
   *  is read no further than that and then skipped: it changed under the search. */
  const readText = async (abs: string): Promise<string | null> => {
    try {
      const st = await lstat(abs)
      if (!st.isFile() || st.size > TEXT_SEARCH_MAX_FILE_BYTES) return null
      const buf = await readUpTo(abs, st.size + 1)
      if (buf.length > st.size || looksBinary(buf)) return null
      return buf.toString('utf8')
    } catch {
      return null // gone since it was listed, or unreadable: nothing to show
    }
  }

  const start = (root: string, query: string): Run => {
    const run: Run = {
      root,
      query,
      matches: [],
      done: false,
      halt: false,
      truncated: false,
      partial: false,
      unavailable: false,
      finished: Promise.resolve()
    }
    run.finished = (async () => {
      try {
        const listed = await deps.index.list(root)
        if (listed.unavailable) {
          run.unavailable = true
          return
        }
        run.partial = listed.truncated
        // Shared by the readers: matchLines runs to the end of a file without awaiting, so no two use it at once
        const pattern = textSearchPattern(query)
        let next = 0
        const reader = async (): Promise<void> => {
          while (!run.halt && next < listed.paths.length) {
            const rel = listed.paths[next++]
            if (isCredentialFile(rel)) continue
            const abs = path.join(root, ...rel.split('/'))
            const text = await readText(abs)
            if (text === null || run.halt) continue
            const room = TEXT_SEARCH_ROWS - run.matches.length
            // One row past the room: a further match is what makes the list "truncated", not merely full
            const found = matchLines(text, pattern, room + 1)
            for (const f of found.slice(0, room)) run.matches.push({ path: abs, ...f })
            if (found.length > room) {
              run.truncated = true
              run.halt = true
            }
          }
        }
        await Promise.all(Array.from({ length: concurrency }, reader))
      } finally {
        run.done = true
      }
    })()
    return run
  }

  const snapshot = (run: Run): TextSearchAnswer => ({
    matches: run.matches.slice(),
    searching: !run.done,
    ...(run.unavailable ? { unavailable: true as const } : {}),
    ...(run.truncated ? { truncated: true as const } : {}),
    ...(run.partial ? { partial: true as const } : {})
  })

  return async (owner, root, query, refresh) => {
    if (typeof root !== 'string' || root === '' || typeof query !== 'string') {
      throw new Error('files.searchText takes a project folder and a query')
    }
    // Stopping reads nothing, so it needs no guard: a box closing on a project since removed still stops its search
    if (query.trim() === '' || query.length > MAX_QUERY) {
      stop(owner)
      return { matches: [], searching: false }
    }
    await deps.allowedRoot(root)
    let run = runs.get(owner)
    if (!run || run.root !== root || run.query !== query) {
      stop(owner)
      if (refresh === true) deps.index.expire(root)
      run = start(root, query)
      runs.set(owner, run)
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    await Promise.race([run.finished, new Promise<void>((resolve) => (timer = setTimeout(resolve, graceMs)))])
    if (timer) clearTimeout(timer)
    return snapshot(run)
  }
}

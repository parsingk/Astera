import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { FileIndex } from './fileIndex'
import {
  isCredentialFile,
  looksBinary,
  matchLines,
  textSearchPattern,
  TEXT_SEARCH_LINES_PER_FILE,
  TEXT_SEARCH_MAX_QUERY,
  type TextMatch,
  type TextSearchAnswer
} from '../core/files/textMatch'

/** How many lines one search lists. Past a screen or two a person types more rather than scrolls a palette. */
export const TEXT_SEARCH_ROWS = 300

/** The largest file read: the editor's own cap (files.read opens a larger file cut at this size), so a match past it is
 *  one the editor could not show. A file this big that matters is a log or a bundle, not what a search looks for. */
export const TEXT_SEARCH_MAX_FILE_BYTES = 1024 * 1024

/** How many files are read at once: enough to keep the disk busy, few enough that one search does not hold every
 *  libuv thread the rest of main needs. */
const READ_CONCURRENCY = 8

/** How long an ask waits for its search before answering with the rows so far. A small project finishes inside it, so
 *  its answer comes in one round trip; a large one answers with what is found and is asked again. */
const GRACE_MS = 100

/** What a search needs to know of a path before reading it. `id` names the file itself (device and file number), so the
 *  reader can tell that the file it opened is the one looked at. */
export interface FileStat {
  isFile: boolean
  size: number
  id: string
}

/** The path itself, never what a link points at: a link is not a regular file and is not read. */
export async function statFile(abs: string): Promise<FileStat> {
  const s = await fs.lstat(abs, { bigint: true })
  return { isFile: s.isFile(), size: Number(s.size), id: `${s.dev}:${s.ino}` }
}

/** At most `max` bytes from the start of the file at `abs`, or null when the file opened there is not the regular file
 *  `id` names: it was swapped (for a link to somewhere outside the project, say) after it was looked at. */
export async function readBounded(abs: string, max: number, id: string): Promise<Buffer | null> {
  const fh = await fs.open(abs, 'r')
  try {
    const s = await fh.stat({ bigint: true })
    if (!s.isFile() || `${s.dev}:${s.ino}` !== id) return null
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

export interface TextSearchDeps {
  /** The project file list Quick Open and the composer's `@` read (main/fileIndex.ts), keyed by the root string. */
  index: Pick<FileIndex, 'list' | 'expire'>
  /** The files IPC's path guard: resolves for a session's folder, a registered worktree or a known project, and for
   *  anything below one; rejects everything else. */
  allowedRoot: (p: string) => Promise<string>
  stat?: (abs: string) => Promise<FileStat>
  readUpTo?: (abs: string, max: number, id: string) => Promise<Buffer | null>
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
  fileCut: boolean
  partial: boolean
  unavailable: boolean
  finished: Promise<void>
}

const NOTHING: TextSearchAnswer = { matches: [], searching: false }

/**
 * Text search's question to main: which lines of the files under this project hold what was typed (spec W2, audit §8
 * item 5).
 *
 * It reads the files the project index lists, so its scope is Quick Open's: the project's .gitignore and .ignore, the
 * folders that are never source, the same cap on a very large project (`partial` then). Of those it skips credential
 * files by name (never even looked at), anything that is not a regular file (a link could lead out of the project),
 * files over the editor's size cap, and binaries. Rows come as files are read, in the index's order give or take the
 * files in flight, at most TEXT_SEARCH_LINES_PER_FILE from one file (`fileCut`) so a root lockfile cannot fill the list,
 * and stop at TEXT_SEARCH_ROWS (`truncated` only when a further line really matches).
 *
 * One search per renderer (`owner`, the sender's id). Asking again with the same root and query answers its progress;
 * a different one stops it and starts anew; an empty or blank query stops it and answers nothing. Every ask and every
 * cancel is numbered as it arrives, before the path guard is awaited, and an ask that something newer overtook while it
 * waited answers nothing and starts nothing: so a search the person has typed past never overwrites the newer one, and
 * closing the box stops the reading even while an ask is still at the guard. `refresh` (true) is the box's first ask
 * and always starts over: the project is walked again before it is listed, as Quick Open does, because the explorer's
 * watcher keeps the list current only while the explorer is open. `stopAll` is for a window that loads a new document,
 * which runs no cleanup of its own.
 */
export function createTextSearch(deps: TextSearchDeps): {
  ask: (owner: number, root: unknown, query: unknown, refresh?: unknown) => Promise<TextSearchAnswer>
  stopAll: () => void
} {
  const stat = deps.stat ?? statFile
  const readUpTo = deps.readUpTo ?? readBounded
  const concurrency = deps.concurrency ?? READ_CONCURRENCY
  const graceMs = deps.graceMs ?? GRACE_MS
  const runs = new Map<number, Run>()
  /** The number of each owner's latest call, ask or cancel. */
  const latest = new Map<number, number>()

  const stop = (owner: number): void => {
    const run = runs.get(owner)
    if (!run) return
    run.halt = true
    runs.delete(owner)
  }

  /** The text of a file worth searching, or null. Bounded by what stat said, so a file growing as it is read (a log)
   *  is read no further than that and then skipped: it changed under the search. */
  const readText = async (abs: string): Promise<string | null> => {
    try {
      const st = await stat(abs)
      if (!st.isFile || st.size > TEXT_SEARCH_MAX_FILE_BYTES) return null
      const buf = await readUpTo(abs, st.size + 1, st.id)
      if (buf === null || buf.length > st.size || looksBinary(buf)) return null
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
      fileCut: false,
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
            const take = Math.min(room, TEXT_SEARCH_LINES_PER_FILE)
            // One line past what is taken: a further match is what makes the list or the file "cut", not merely full
            const found = matchLines(text, pattern, take + 1)
            for (const f of found.slice(0, take)) run.matches.push({ path: abs, ...f })
            if (found.length > take) {
              if (take === room) {
                run.truncated = true
                run.halt = true
              } else run.fileCut = true
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
    ...(run.fileCut ? { fileCut: true as const } : {}),
    ...(run.partial ? { partial: true as const } : {})
  })

  const ask = async (owner: number, root: unknown, query: unknown, refresh?: unknown): Promise<TextSearchAnswer> => {
    if (typeof root !== 'string' || root === '' || typeof query !== 'string') {
      throw new Error('files.searchText takes a project folder and a query')
    }
    const mine = (latest.get(owner) ?? 0) + 1
    latest.set(owner, mine)
    // Stopping reads nothing, so it needs no guard: a box closing on a project since removed still stops its search
    if (query.trim() === '' || query.length > TEXT_SEARCH_MAX_QUERY) {
      stop(owner)
      return NOTHING
    }
    await deps.allowedRoot(root)
    if (latest.get(owner) !== mine) return NOTHING
    let run = runs.get(owner)
    if (!run || run.root !== root || run.query !== query || refresh === true) {
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

  return {
    ask,
    stopAll: () => {
      for (const owner of [...runs.keys()]) stop(owner)
      // An ask still at the guard belongs to the old document too
      for (const [owner, n] of latest) latest.set(owner, n + 1)
    }
  }
}

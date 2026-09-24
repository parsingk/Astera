// The writer of the Host's merge records (carry 1, R24): `begin` writes the HEAD before a merge,
// `end` completes it with the HEAD after. The shape and the reader are core/git/hostMerges.ts.
//
// **A record costs the merge nothing.** Every failure here — HEAD unreadable, a file that cannot be
// read or written — is logged and swallowed: `begin` still answers its id and the merge goes on. The
// record only keeps the app from calling Astera's own merge an outside change; a merge refused for
// want of one would be the worse outcome.
//
// Node builtins and core modules only: this bundles into the Host.

import path from 'node:path'
import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { HOST_MERGES_KEPT, parseHostMerges, type HostMergeRecord } from '../core/git/hostMerges'
import { readFileRetrying, renameRetrying } from '../core/renameRetry'

export interface MergeRecorder {
  begin(projectPath: string): Promise<string>
  end(id: string): Promise<void>
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Whether the text is the record file at all: `{ "merges": [...] }`. Entries inside it that are not
 *  records are dropped by parseHostMerges, as the reader drops them; the file is not damaged for that. */
const isHostMergesFile = (text: string): boolean => {
  try {
    const v: unknown = JSON.parse(text)
    return typeof v === 'object' && v !== null && !Array.isArray(v) && Array.isArray((v as { merges?: unknown }).merges)
  } catch {
    return false
  }
}

export function createMergeRecorder(a: {
  file: string
  headOf(cwd: string): Promise<string | null>
  now(): string
  log(m: string): void
}): MergeRecorder {
  /** One chain, so the writes run in order: each reads the file the previous one left. */
  let chain: Promise<void> = Promise.resolve()

  /** What is on disk before a write (review m1). Not readHostMerges, whose "[] on any failure" is right
   *  for the app's reader and wrong here: one failed read would rewrite the file as a list of one and
   *  drop every earlier record. So only a missing file is empty; a damaged one is kept as `.bak` and
   *  the history starts over, said in the log; any other read error throws, and the write is skipped. */
  const current = async (): Promise<HostMergeRecord[]> => {
    let text: string
    try {
      text = await readFileRetrying(a.file)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error(`${path.basename(a.file)} could not be read, so it is left as it is: ${message(err)}`)
    }
    if (isHostMergesFile(text)) return parseHostMerges(text)
    const bak = `${a.file}.bak`
    await fs.writeFile(bak, text, 'utf8')
    a.log(`${path.basename(a.file)} was damaged; kept as ${path.basename(bak)}, and the merge history starts fresh`)
    return []
  }

  const write = async (change: (records: HostMergeRecord[]) => HostMergeRecord[]): Promise<void> => {
    const next = change(await current()).slice(-HOST_MERGES_KEPT)
    await fs.mkdir(path.dirname(a.file), { recursive: true })
    // Atomic (tmp + rename), as the other profile stores are: the app may be reading it right now.
    const tmp = `${a.file}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(tmp, JSON.stringify({ merges: next }, null, 2), 'utf8')
      await renameRetrying(tmp, a.file)
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {})
    }
  }
  const queue = (id: string, change: (records: HostMergeRecord[]) => HostMergeRecord[]): Promise<void> => {
    const turn = chain.then(() => write(change)).catch((err: unknown) => {
      a.log(`merge record ${id} could not be written: ${message(err)}`)
    })
    chain = turn
    return turn
  }
  const head = async (cwd: string): Promise<string | null> => {
    try {
      return await a.headOf(cwd)
    } catch (err) {
      a.log(`merge record: HEAD of ${cwd} could not be read: ${message(err)}`)
      return null
    }
  }

  const projectOf = new Map<string, string>()
  return {
    begin: async (projectPath) => {
      const id = randomUUID()
      projectOf.set(id, projectPath)
      const record: HostMergeRecord = { id, projectPath, headBefore: await head(projectPath), startedAt: a.now() }
      await queue(id, (records) => [...records.filter((r) => r.id !== id), record])
      return id
    },
    end: async (id) => {
      const projectPath = projectOf.get(id)
      projectOf.delete(id)
      if (projectPath === undefined) {
        a.log(`merge record ${id} could not be written: no merge began under that id`)
        return
      }
      const headAfter = await head(projectPath)
      const endedAt = a.now()
      await queue(id, (records) => records.map((r) => (r.id === id ? { ...r, headAfter, endedAt } : r)))
    }
  }
}

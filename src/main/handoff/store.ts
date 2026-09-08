// handoff.json persistence — one handoff memo per session. The WorkUnitStore pattern: type guard →
// atomic tmp+rename write → on a parse failure, back up to .bak and start empty; saves queued with
// then(run, run) so one failed write does not stall every later one.
//
// **What is different from WorkUnitStore, and why.** A failed or corrupt load leaves this store
// answering `unknown` rather than `none` until the next successful save (spec §7): the briefing
// prints "none was left" only when the app actually knows that, and a file it could not read is
// not that. The tab-resume folder is cleared on every launch, so the memo cannot live there — it
// has to survive an app restart to be of any use to a history resume.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Handoff, HandoffLookup } from '../../core/handoff/types'

/** Sessions kept, newest first by createdAt. Two hundred is months of ordinary use; the file stays
 *  small (a memo is bounded by HANDOFF_DOCUMENT_MAX) and nothing ever reads a memo for a session
 *  the history screen no longer lists. */
export const HANDOFF_KEEP_MAX = 200

interface StoreShape {
  version: 1
  memos: Record<string, Handoff>
}

export interface HandoffStoreDeps {
  /** Test-only injection point for a write that fails mid-way; the default is fs.writeFile. The
   *  path it receives is the temporary file (rename swaps it in). */
  writeFile?(path: string, content: string): Promise<void>
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** Per-memo shape is checked exactly as far as what section.ts indexes unconditionally: the key,
 *  the pruning order, and the seven list fields the renderer reads without a guard. Anything else
 *  is what the app wrote and is read back as it is — the same policy orchestration/store.ts and
 *  workUnit/store.ts explain. A memo missing one of the seven fails here rather than reaching the
 *  renderer, which would throw on it. */
function isValid(v: unknown): v is StoreShape {
  return (
    isObj(v) &&
    v.version === 1 &&
    isObj(v.memos) &&
    Object.entries(v.memos).every(
      ([key, m]) =>
        isObj(m) &&
        m.sessionId === key &&
        typeof m.createdAt === 'string' &&
        Array.isArray(m.completed) &&
        Array.isArray(m.currentProblems) &&
        Array.isArray(m.nextActions) &&
        Array.isArray(m.constraints) &&
        Array.isArray(m.decisions) &&
        Array.isArray(m.verification) &&
        Array.isArray(m.relevantFiles)
    )
  )
}

export class HandoffStore {
  private state: StoreShape = { version: 1, memos: {} }
  /** True once a load succeeded (ENOENT counts — a store that never existed is known empty) or a
   *  save committed. While false, lookup answers `unknown` for every id. */
  private known = false
  private queue: Promise<void> = Promise.resolve()
  private readonly writeFile: (p: string, c: string) => Promise<void>

  constructor(
    private filePath: string,
    deps: HandoffStoreDeps = {}
  ) {
    this.writeFile = deps.writeFile ?? ((p, c) => fs.writeFile(p, c, 'utf8'))
  }

  async load(): Promise<{ recovered: boolean }> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        this.known = true
        return { recovered: false }
      }
      return this.recover()
    }
    if (!isValid(parsed)) return this.recover()
    this.state = parsed
    this.known = true
    return { recovered: false }
  }

  /** copyFile rather than rename, so a file we could not even read (a permission error) is still
   *  kept aside for a person to look at. */
  private async recover(): Promise<{ recovered: boolean }> {
    await fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
    this.state = { version: 1, memos: {} }
    this.known = false
    return { recovered: true }
  }

  lookup(sessionId: string): HandoffLookup {
    if (!this.known) return { state: 'unknown' }
    const memo = this.state.memos[sessionId]
    return memo ? { state: 'found', memo } : { state: 'none' }
  }

  /** Replaces the session's memo and prunes to HANDOFF_KEEP_MAX. Memory is updated only after the
   *  rename succeeded, so a failed write never leaves lookup answering with a memo the disk does not
   *  hold (spec §13). The next state is computed inside the queued run, not at call time — two
   *  saves in flight would otherwise each build on the state before the other. */
  save(memo: Handoff): Promise<void> {
    const run = async (): Promise<void> => {
      const merged = { ...this.state.memos, [memo.sessionId]: memo }
      const kept = Object.values(merged)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, HANDOFF_KEEP_MAX)
      const next: StoreShape = {
        version: 1,
        memos: Object.fromEntries(kept.map((m) => [m.sessionId, m]))
      }
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.${randomUUID()}.tmp`
      try {
        await this.writeFile(tmp, JSON.stringify(next, null, 2))
        await fs.rename(tmp, this.filePath)
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {})
        throw err
      }
      this.state = next
      this.known = true
    }
    // then(run, run): a rejected save must not stop the next one from running.
    this.queue = this.queue.then(run, run)
    return this.queue
  }
}

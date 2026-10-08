// understanding.json persistence. The OrchestrationStore pattern — type guard → atomic tmp+rename
// write → on a parse failure, back up to .bak and start empty.
//
// Why this is a separate file from orchestration.json: the two models have different lifetimes.
// A Run is discarded after RUN_TTL_MS (30 days); a feature explanation must live as long as the
// project does. Sharing a file would let one side's cleanup rule delete the other's data.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectUnderstanding } from './types'
// The shape guard is core's so the Host's read-only reader (core/understanding/read.ts) takes and
// refuses exactly what this store does.
import { isValid, type StoreShape } from './read'
import { renameRetrying } from '../renameRetry'
import { keepDamaged, readStoreFile, StoreUnread } from '../storeFile'

export class UnderstandingStore {
  private state: StoreShape = { projects: {} }
  /** Serialization queue for disk writes — the OrchestrationStore convention */
  private queue: Promise<void> = Promise.resolve()
  /** The file as this store last loaded or saved it (mtime and size), or null when it has seen none.
   *  refresh() compares the file with it to tell another process's write from its own. */
  private seen: string | null = null
  /** Counts set and remove. refresh() adopts the file only when none ran while it was reading: a write
   *  made meanwhile is newer than the file it read, and may not have reached the disk yet. */
  private writes = 0

  constructor(private filePath: string) {}

  /** `unstuck` names the projects whose `generating` records it marked interrupted, **in memory only**:
   *  saving them is a writer's call (the Host saves them only while it is the one writer, E1 §2).
   *  `interrupted` names those records by id, so a writer that later adopts a newer file can tell a
   *  record load marked from one another writer started after it. */
  async load(): Promise<{ recovered: boolean; unstuck: string[]; interrupted: string[] }> {
    let parsed: unknown
    // Stamped before the read: taken after, a write landing between the two would be taken for the file
    // this store read, and refresh() would never adopt it.
    const stamp = await this.stamp(this.filePath)
    // **ENOENT 만 "아직 없다" 다**, and a file that could not be read is not damaged either (audit U-1): it was
    // taken for damage, the store started empty, and the next set() erased every project's records. It is marked
    // unread instead, and the next write reads it again first (readAgain).
    const r = await readStoreFile(this.filePath)
    if (r.kind === 'missing') {
      this.unread = null
      return { recovered: false, unstuck: [], interrupted: [] }
    }
    if (r.kind === 'unreadable') {
      this.unread = r.error
      return { recovered: false, unstuck: [], interrupted: [] }
    }
    this.unread = null
    try {
      parsed = JSON.parse(r.text)
    } catch {
      return this.recover(r.text)
    }
    if (!isValid(parsed)) return this.recover(r.text)
    this.state = parsed
    this.seen = stamp
    return { recovered: false, ...this.unstick() }
  }

  /** What load could not read, kept until a write reads the file again (audit U-1); null when it was read. */
  private unread: unknown = null

  /** Before a write over a file load could not read: reads it now, and adopts it; throws when it still cannot be
   *  read, so nothing is written over it. */
  private async readAgain(): Promise<void> {
    const stamp = await this.stamp(this.filePath)
    const r = await readStoreFile(this.filePath)
    if (r.kind === 'unreadable') throw new StoreUnread(this.filePath, r.error)
    this.unread = null
    if (r.kind === 'missing') return
    let parsed: unknown = null
    try {
      parsed = JSON.parse(r.text)
    } catch {
      /* damaged: kept aside below */
    }
    if (!isValid(parsed)) {
      await this.recover(r.text)
      return
    }
    this.state = parsed
    this.seen = stamp
  }

  /** Reads the file again **only when another process wrote it** since this store last loaded or saved
   *  it, and returns whether it did. Called before every write a computed value hangs on (pipeline.ts
   *  prepend and patch): the Host and an older app can each be the writer in turn (E1 §2), and a write
   *  computed from memory would erase what the other wrote meanwhile.
   *
   *  **Never unsticks.** A `generating` record in the file may be this process's own generation in
   *  flight; only load, at start, may call it interrupted. It waits for this store's queued saves first,
   *  so it never reads a file under its own pending write. A file that cannot be read or is not valid is
   *  not adopted: what this store holds stays, as a write over a damaged file did before.
   *
   *  **Not over a newer write.** A caller outside the pipeline's queue (the Host's regenerate) can refresh
   *  while the pipeline sets: a set made after this refresh began is kept, and the file it read is not
   *  adopted. The next refresh compares again. */
  async refresh(): Promise<boolean> {
    const writes = this.writes
    await this.queue.catch(() => {})
    const now = await this.stamp(this.filePath)
    if (now === null || now === this.seen) return false
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
    } catch {
      return false
    }
    if (!isValid(parsed) || this.writes !== writes) return false
    this.state = parsed
    this.seen = now
    return true
  }

  /** Resolves once every save queued so far has landed (or failed). Never rejects. */
  settled(): Promise<void> {
    return this.queue.catch(() => {})
  }

  /** The project keys as the file spells them, for a caller that matches a path the way the readers do
   *  (read.ts recordsFor, isSamePath). */
  projectKeys(): string[] {
    return Object.keys(this.state.projects)
  }

  get(projectPath: string): ProjectUnderstanding | undefined {
    return this.state.projects[projectPath]
  }

  set(projectPath: string, value: ProjectUnderstanding): Promise<void> {
    if (this.unread !== null) return this.readAgain().then(() => this.set(projectPath, value))
    this.state.projects[projectPath] = value
    this.writes += 1
    return this.save()
  }

  remove(projectPath: string): Promise<void> {
    if (this.unread !== null) return this.readAgain().then(() => this.remove(projectPath))
    delete this.state.projects[projectPath]
    this.writes += 1
    return this.save()
  }

  private save(): Promise<void> {
    // Compact (audit U-3): the file is rewritten whole on every change, and indenting it made it a third larger.
    const snapshot = JSON.stringify(this.state)
    const run = async (): Promise<void> => {
      // Its own temp file (E1 §2): the Host and an app can both hold a store over this file, and a shared
      // `.tmp` would let one process rename the other's half-written snapshot into place.
      const tmp = `${this.filePath}.${process.pid}.tmp`
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      await fs.writeFile(tmp, snapshot, 'utf8')
      // Stamped from the temp file: a rename keeps mtime and size, and reading the target after it
      // could take another process's write that landed in between for this one's.
      const stamp = await this.stamp(tmp)
      // Retried: on win32 a rename over a file another process is reading (the app's reader, an MCP
      // read tool) is refused for the moment the handle is open.
      try {
        await renameRetrying(tmp, this.filePath)
      } catch (err) {
        // Refused past its retries: this process's temp file would otherwise stay beside the target.
        await fs.rm(tmp, { force: true }).catch(() => {})
        throw err
      }
      this.seen = stamp
    }
    // then(run, run) 의 두 인자가 같은 이유: 앞선 쓰기가 실패해도 다음 쓰기는 진행돼야 한다.
    // onRejected 가 없으면 한 번 거절된 큐가 이후의 모든 save 를 그대로 거절로 흘려보내고,
    // 그 시점부터 디스크가 얼어붙는다 — OrchestrationStore.save 의 주석이 경고하는 그 실패다.
    this.queue = this.queue.then(run, run)
    return this.queue
  }

  private async stamp(p: string): Promise<string | null> {
    try {
      const st = await fs.stat(p)
      return `${st.mtimeMs}:${st.size}`
    } catch {
      return null
    }
  }

  /** 통째로 되돌린다. 항목끼리 참조가 걸려 있어(feature ↔ explanation) 한 항목만 버리면 매달린
   *  참조가 남고, 그것은 처음부터 다시 하는 것보다 나쁜 상태다.
   *
   *  copyFile 을 쓰는 이유: 내용을 읽지 못해서 온 경우(권한 오류)에도 원본을 물려 둘 수 있다. */
  private async recover(text: string): Promise<{ recovered: boolean; unstuck: string[]; interrupted: string[] }> {
    // The bytes it read, never over an earlier copy (audit U-1).
    await keepDamaged(this.filePath, text)
    this.state = { projects: {} }
    return { recovered: true, unstuck: [], interrupted: [] }
  }

  /** A record left in `generating` on disk is always a lie: the agent is a child of this process and
   *  died with it. Left alone it spins forever with no way to retry. **True only here** — load runs
   *  once, before any generation. Returns the projects it changed and the records it marked. */
  private unstick(): { unstuck: string[]; interrupted: string[] } {
    const changed: string[] = []
    const interrupted: string[] = []
    for (const [key, u] of Object.entries(this.state.projects))
      for (const r of u.records)
        if (r.status === 'generating') {
          r.status = 'failed'
          r.reason = 'INTERRUPTED'
          interrupted.push(r.id)
          if (!changed.includes(key)) changed.push(key)
        }
    return { unstuck: changed, interrupted }
  }
}

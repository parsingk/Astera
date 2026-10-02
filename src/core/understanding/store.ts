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

  async load(): Promise<{ recovered: boolean }> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
    } catch (e) {
      // **ENOENT 만 "아직 없다" 다.** 나머지 읽기 오류(EACCES·EPERM·EISDIR)를 같이 삼키면, 읽지
      // 못한 기존 파일을 다음 set() 이 조용히 덮어쓴다 — 사용자에게 아무 신호 없이 데이터가 사라진다.
      // OrchestrationStore.load 가 같은 이유로 이 갈래를 가른다.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { recovered: false }
      return this.recover()
    }
    if (!isValid(parsed)) return this.recover()
    this.state = parsed
    this.seen = await this.stamp(this.filePath)
    this.unstick()
    return { recovered: false }
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

  get(projectPath: string): ProjectUnderstanding | undefined {
    return this.state.projects[projectPath]
  }

  set(projectPath: string, value: ProjectUnderstanding): Promise<void> {
    this.state.projects[projectPath] = value
    this.writes += 1
    return this.save()
  }

  remove(projectPath: string): Promise<void> {
    delete this.state.projects[projectPath]
    this.writes += 1
    return this.save()
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2)
    const run = async (): Promise<void> => {
      // Its own temp file (E1 §2): the Host and an app can both hold a store over this file, and a shared
      // `.tmp` would let one process rename the other's half-written snapshot into place.
      const tmp = `${this.filePath}.${process.pid}.tmp`
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      await fs.writeFile(tmp, snapshot, 'utf8')
      // Stamped from the temp file: a rename keeps mtime and size, and reading the target after it
      // could take another process's write that landed in between for this one's.
      const stamp = await this.stamp(tmp)
      await fs.rename(tmp, this.filePath)
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
  private async recover(): Promise<{ recovered: boolean }> {
    await fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
    this.state = { projects: {} }
    return { recovered: true }
  }

  /** A record left in `generating` on disk is always a lie: the agent is a child of this process and
   *  died with it. Left alone it spins forever with no way to retry. **True only here** — load runs
   *  once, before any generation. */
  private unstick(): void {
    for (const u of Object.values(this.state.projects))
      for (const r of u.records)
        if (r.status === 'generating') {
          r.status = 'failed'
          r.reason = 'INTERRUPTED'
        }
  }
}

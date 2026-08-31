// understanding.json persistence. The OrchestrationStore pattern — type guard → atomic tmp+rename
// write → on a parse failure, back up to .bak and start empty.
//
// Why this is a separate file from orchestration.json: the two models have different lifetimes.
// A Run is discarded after RUN_TTL_MS (30 days); a feature explanation must live as long as the
// project does. Sharing a file would let one side's cleanup rule delete the other's data.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ProjectUnderstanding } from '../../core/understanding/types'

/** projectPath → 그 프로젝트의 이해. orchestration.json 과 같은 갈래로, 프로젝트를 나누는 것은
 *  파일이 아니라 파일 안의 키다 */
interface StoreShape {
  projects: Record<string, ProjectUnderstanding>
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

function isUnderstanding(v: unknown): v is ProjectUnderstanding {
  if (!isObj(v)) return false
  return Array.isArray(v.records)
}

function isValid(v: unknown): v is StoreShape {
  if (!isObj(v) || !isObj(v.projects)) return false
  return Object.values(v.projects).every(isUnderstanding)
}

export class UnderstandingStore {
  private state: StoreShape = { projects: {} }
  /** Serialization queue for disk writes — the OrchestrationStore convention */
  private queue: Promise<void> = Promise.resolve()

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
    return { recovered: false }
  }

  get(projectPath: string): ProjectUnderstanding | undefined {
    return this.state.projects[projectPath]
  }

  set(projectPath: string, value: ProjectUnderstanding): Promise<void> {
    this.state.projects[projectPath] = value
    return this.save()
  }

  remove(projectPath: string): Promise<void> {
    delete this.state.projects[projectPath]
    return this.save()
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2)
    const run = async (): Promise<void> => {
      const tmp = this.filePath + '.tmp'
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      await fs.writeFile(tmp, snapshot, 'utf8')
      await fs.rename(tmp, this.filePath)
    }
    // then(run, run) 의 두 인자가 같은 이유: 앞선 쓰기가 실패해도 다음 쓰기는 진행돼야 한다.
    // onRejected 가 없으면 한 번 거절된 큐가 이후의 모든 save 를 그대로 거절로 흘려보내고,
    // 그 시점부터 디스크가 얼어붙는다 — OrchestrationStore.save 의 주석이 경고하는 그 실패다.
    this.queue = this.queue.then(run, run)
    return this.queue
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
}

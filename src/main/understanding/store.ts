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
  return Array.isArray(v.features) && isObj(v.explanations) && Array.isArray(v.recentChanges)
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
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf8')
    } catch {
      return { recovered: false } // 아직 없다 — 빈 상태가 맞다
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isValid(parsed)) throw new Error('shape')
      this.state = parsed
      return { recovered: false }
    } catch {
      // 통째로 되돌린다. 항목끼리 참조가 걸려 있어(feature ↔ explanation) 한 항목만 버리면
      // 매달린 참조가 남고, 그것은 처음부터 다시 하는 것보다 나쁜 상태다
      await fs.writeFile(this.filePath + '.bak', raw, 'utf8').catch(() => {})
      this.state = { projects: {} }
      return { recovered: true }
    }
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
    this.queue = this.queue.then(async () => {
      const tmp = this.filePath + '.tmp'
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      await fs.writeFile(tmp, snapshot, 'utf8')
      await fs.rename(tmp, this.filePath)
    })
    return this.queue
  }
}

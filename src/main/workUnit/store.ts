// workUnits.json persistence. The OrchestrationStore pattern — type guard → atomic tmp+rename
// write → on a parse failure, back up to .bak and start empty.
//
// **understanding.json 저장소가 실제로 겪은 두 버그를 되풀이하지 않는다.**
//   1. save 의 큐는 then(run, run) 이어야 한다. onRejected 가 없으면 일시적 쓰기 실패 하나로
//      이후 모든 저장이 조용히 멈추고, get() 은 갱신된 메모리 값을 계속 돌려주므로 증상이 없다.
//   2. load 는 ENOENT 만 "아직 없다"로 본다. 나머지 읽기 오류를 함께 삼키면 권한 오류가 난
//      기존 파일을 다음 쓰기가 덮어쓴다.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ExternalGitChange } from '../../core/git/types'
import type { SessionWorkUnit, TranscriptCursor } from '../../core/workUnit/types'

/** 설계 §9 의 ProjectGitSnapshot — "Astera 가 마지막으로 알던 git 상태"(EG §4).
 *
 *  **`core/git/types.ts` 가 아니라 여기 있는 이유:** 이것은 전이 판정이 다루는 값(`GitRef`)이 아니라
 *  **저장 파일의 한 칸**이고, `capturedAt` 이 그 말을 하고 있다 — 프로세스보다 오래 사는 기록에만
 *  "언제 찍었는가"가 뜻이 있다. 그래서 저장 모양을 적는 이 파일에 둔다.
 *
 *  **디스크에 남는 것이 요점이다.** 메모리에만 있으면 앱이 꺼져 있던 동안의 pull·브랜치 전환·
 *  rebase 가 통째로 사라지고(EG §41-10·§42-17), 켤 때마다 그 프로젝트의 첫 외부 변경 하나가
 *  기준선에 삼켜진다. */
export interface ProjectGitSnapshot {
  projectPath: string
  /** detached HEAD 면 null */
  branch: string | null
  /** 커밋이 하나도 없는 저장소면 null */
  head: string | null
  capturedAt: string
}

export interface WorkUnitState {
  units: SessionWorkUnit[]
  cursors: TranscriptCursor[]
  externalGitChanges: ExternalGitChange[]
  /** **Optional field.** A `workUnits.json` written before this field existed is already on disk,
   *  and making it required would fail the type guard and send that whole file to `.bak` — `isState`
   *  looks at a top-level slot like this one **directly**.
   *
   *  This is not the same situation as an optional field on `SessionWorkUnit` (this file's comment
   *  used to say so — it was wrong). A unit's own fields sit one level down, inside the `units`
   *  array, and `isValid` never opens an individual unit's shape at all (see the comment on `isValid`
   *  just below) — so a unit gaining an optional field does not need one to keep old files readable;
   *  that guard was never checking unit fields to begin with. Only here, at the top level that
   *  `isState` does inspect directly, is "optional" what keeps an old file out of `.bak`. */
  gitSnapshot?: ProjectGitSnapshot
}

/** projectPath → that project's state. **Not the same key space as `understanding.json`.**
 *  `understanding.json` folds a worktree session's project onto its origin repository
 *  (`understandingKeyOf`, design D1); this store does not — a `CollectorSession.projectPath` is
 *  written and read back verbatim (ipc.ts's `sessionTasks.list` handler explains why folding here
 *  would be wrong: it would ask the *other* store's key of *this* one, which holds nothing under
 *  it). Confusing the two key spaces is exactly what Task 5's Critical bug was. */
interface StoreShape {
  projects: Record<string, WorkUnitState>
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

function isState(v: unknown): v is WorkUnitState {
  if (!isObj(v)) return false
  return (
    Array.isArray(v.units) &&
    Array.isArray(v.cursors) &&
    Array.isArray(v.externalGitChanges) &&
    // 선택 필드라 없어도 좋다. 있을 때 보는 것은 배열들과 같은 깊이 — "객체인가" 하나뿐이다
    (v.gitSnapshot === undefined || isObj(v.gitSnapshot)) &&
    // `messages` was dropped when the boundary became declared. Older files still carry it, so the
    // guard accepts it and the next write leaves it behind — requiring it would `.bak` every file
    // written before this change.
    (v.messages === undefined || Array.isArray(v.messages))
  )
}

/** 원소 하나하나의 모양은 보지 않는다. orchestration/store.ts 가 같은 정책을 쓰고 그 이유를
 *  적어 두었다 — 앱이 스스로 쓰는 로그성 데이터이고, 모양이 어긋나면 통째로 복구하는 것이
 *  옳은 답이다. 매달린 참조를 남기는 부분 복구보다 낫다. */
function isValid(v: unknown): v is StoreShape {
  return isObj(v) && isObj(v.projects) && Object.values(v.projects).every(isState)
}

export class WorkUnitStore {
  private state: StoreShape = { projects: {} }
  private queue: Promise<void> = Promise.resolve()

  constructor(private filePath: string) {}

  async load(): Promise<{ recovered: boolean }> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { recovered: false }
      return this.recover()
    }
    if (!isValid(parsed)) return this.recover()
    // Statuses from before the boundary was declared. `completed-candidate` meant "the agent
    // stopped and something changed" — nobody confirmed it, so it goes in front of the person.
    // `abandoned` meant "closed with nothing observed", which nothing downstream ever read.
    for (const state of Object.values(parsed.projects)) {
      state.units = state.units.filter((u) => (u.status as string) !== 'abandoned')
      for (const u of state.units) {
        if ((u.status as string) === 'completed-candidate') {
          u.status = 'interrupted'
          u.reason = 'INTERRUPTED_BY_APP_UPGRADE'
        }
        const legacy = u as unknown as { title?: string }
        if (!u.objective && legacy.title) u.objective = legacy.title
      }
    }
    this.state = parsed
    return { recovered: false }
  }

  /** copyFile 을 쓰는 이유: 내용을 읽지 못해서 온 경우(권한 오류)에도 원본을 물려 둘 수 있다 */
  private async recover(): Promise<{ recovered: boolean }> {
    await fs.copyFile(this.filePath, this.filePath + '.bak').catch(() => {})
    this.state = { projects: {} }
    return { recovered: true }
  }

  get(projectPath: string): WorkUnitState | undefined {
    return this.state.projects[projectPath]
  }

  /** Every project this store currently holds a state for. **Only for sweeps that must reach a
   *  project with no live session** (the collector's `seed()` orphan-interrupt) — everyday code
   *  should still be handed a `projectPath` rather than enumerate the whole store. */
  projectPaths(): string[] {
    return Object.keys(this.state.projects)
  }

  set(projectPath: string, value: WorkUnitState): Promise<void> {
    this.state.projects[projectPath] = value
    return this.save()
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2)
    const run = async (): Promise<void> => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      // tmp 이름에 randomUUID 를 붙이는 것은 OrchestrationStore.writeNow 와 같다 —
      // 두 프로세스가 같은 tmp 를 밟지 않게 한다
      const tmp = `${this.filePath}.${randomUUID()}.tmp`
      await fs.writeFile(tmp, snapshot, 'utf8')
      await fs.rename(tmp, this.filePath)
    }
    // then(run, run) 의 두 인자가 같은 이유는 이 파일 머리주석의 1번이다
    this.queue = this.queue.then(run, run)
    return this.queue
  }
}

// 분리 이전의 `Run` 을 Job + 회차로 가른다
// (docs/2026-09-21-job-run-split-and-projects-design.md §5).
//
// **store.ts 가 아니라 여기 있는 이유.** 이 판정은 파일을 읽는 일과 아무 관계가 없다 — 배열을 받아
// 배열을 돌려주는 순수 함수다. 여기 있으면 테스트가 fs 없이 돌고, 분리 전에 쓰인 기존 테스트들도
// 이 함수로 옛 모양을 그대로 적을 수 있다(그 파일들이 검사하는 것은 이 변환이 아니다).
import { newId, type ConvergencePolicy, type Job, type JobRun, type Task } from './types'
import type { ScheduleRule } from '../scheduler/rule'

/** 한 배열에 보통 Run·예약 템플릿·회차가 섞여 있던 시절의 모양. **지운 칸까지 이름을 남겨 둔다** —
 *  무엇이 어디로 갔는지가 이 한 곳에 적혀 있어야 한다. */
export interface LegacyRun {
  id: string
  objective?: string
  cwd?: string
  projectId?: string
  createdAt?: string
  concurrency?: number
  coordinatorAccountId?: string
  coordinatorSessionId?: string
  autoDispatch?: boolean
  pendingStart?: boolean
  schedule?: ScheduleRule
  fireCount?: number
  fireOrdinal?: number
  worktree?: string
  paused?: boolean
  templateId?: string
  convergence?: ConvergencePolicy
}

export interface SplitResult {
  jobs: Job[]
  runs: JobRun[]
  /** 소유가 바뀐 Task 들. 예약 템플릿과 아직 시작하지 않은 초안의 Task 는 계획의 **정의**가 되므로
   *  `runId` 를 잃고 `jobId` 를 얻는다. 나머지는 그대로다(그 회차가 옛 id 를 물려받았으므로). */
  tasks: Task[]
}

/**
 * **옛 Run 의 id 는 회차가 물려받는다.** Task.runId 도, 그 아래 Dispatch 도, 저널에 이미 적힌
 * runId 도 전부 그것을 가리키고 있었다 — 반대로 하면 저널을 통째로 다시 써야 한다. 새 id 를 받는
 * 것은 Job 쪽뿐이다.
 *
 * `newJobId` 는 주입된다 — 테스트가 결과를 눈으로 읽을 수 있어야 하고, 이 함수의 유일한 비결정성이
 * 그것이기 때문이다.
 */
export function splitLegacyRuns(
  legacy: LegacyRun[],
  tasks: Task[],
  newJobId: () => string = () => newId('job')
): SplitResult {
  const jobs: Job[] = []
  const runs: JobRun[] = []
  const jobIdOf = new Map<string, string>()
  const definitionOf = new Map<string, string>()

  const asJob = (r: LegacyRun): Job => ({
    id: newJobId(),
    objective: r.objective ?? '',
    cwd: r.cwd ?? '',
    ...(r.projectId ? { projectId: r.projectId } : {}),
    createdAt: r.createdAt ?? '',
    ...(r.concurrency !== undefined ? { concurrency: r.concurrency } : {}),
    ...(r.coordinatorAccountId ? { coordinatorAccountId: r.coordinatorAccountId } : {}),
    ...(r.autoDispatch ? { autoDispatch: true } : {}),
    ...(r.schedule ? { schedule: r.schedule } : {}),
    ...(r.pendingStart ? { pendingStart: true } : {}),
    // paused 는 예약에만 뜻이 있다 — 보통 Run 의 그 칸은 회차 쪽으로 간다
    ...(r.paused && r.schedule ? { paused: true } : {}),
    ...(r.convergence ? { convergence: r.convergence } : {})
  })

  const asRun = (r: LegacyRun, jobId: string, ordinal: number): JobRun => ({
    id: r.id,
    jobId,
    ordinal,
    createdAt: r.createdAt ?? '',
    ...(r.coordinatorSessionId ? { coordinatorSessionId: r.coordinatorSessionId } : {}),
    ...(r.worktree ? { worktree: r.worktree } : {}),
    ...(r.paused ? { paused: true } : {})
  })

  // 1) 회차가 아닌 것이 Job 이 된다.
  for (const r of legacy) {
    if (typeof r.templateId === 'string') continue
    const job = asJob(r)
    jobs.push(job)
    jobIdOf.set(r.id, job.id)
    // 예약 템플릿과 아직 시작하지 않은 초안은 **스스로 돈 적이 없다** — 회차를 만들지 않고 그
    // Task 를 계획의 정의로 옮긴다. 나머지(이미 돌던 보통 Run)는 그 자신이 1회차다.
    if (r.schedule !== undefined || r.pendingStart === true) {
      definitionOf.set(r.id, job.id)
      if (r.fireCount !== undefined) job.fireCount = r.fireCount
    } else {
      runs.push(asRun(r, job.id, 1))
      // 다음 회차가 2회차가 되도록. 예약이 아닌 Run 에는 이 칸이 없었다.
      job.fireCount = 1
    }
  }

  // 2) 회차. 부모를 못 찾으면 **버리지 않고 자기 Job 을 준다** — 옛 view.ts 가 고아 회차를 최상위에
  //    남겨 두던 것과 같은 판단이다: 삼키면 목록에서 사라지고 지울 문도 없어진다. 회차도 계획 칸을
  //    전부 들고 있었으므로(발화가 복사했다) Job 을 만들 재료가 있다.
  for (const r of legacy) {
    if (typeof r.templateId !== 'string') continue
    const parent = jobIdOf.get(r.templateId)
    if (parent !== undefined) {
      runs.push(asRun(r, parent, r.fireOrdinal ?? 1))
      continue
    }
    const own = asJob(r)
    delete own.schedule
    own.fireCount = r.fireOrdinal ?? 1
    jobs.push(own)
    runs.push(asRun(r, own.id, r.fireOrdinal ?? 1))
  }

  const nextTasks = tasks.map((t) => {
    const jobId = t.runId === undefined ? undefined : definitionOf.get(t.runId)
    if (jobId === undefined) return t
    const { runId: _drop, ...rest } = t
    return { ...rest, jobId }
  })

  return { jobs, runs, tasks: nextTasks }
}

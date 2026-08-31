// The impure edges around writing a record — Electron, the filesystem, the agent process. The pure
// judgment calls (what evidence counts, what shape a prompt takes, what a valid record looks like)
// live in core's pure functions (changeRecord · prompt · validate); this file only sequences them
// and persists the result. Same split as workUnit/collector.ts.
//
// **Two writers, one shape.** A closed work unit (onUnitClosed) and a finished Job Run
// (onRunFinished) both write a WorkRecord the same way: create it immediately with status
// 'generating', then fill it in once the agent answers — the write-up itself can take minutes.
//
// **One at a time.** The agent process is expensive (tens of seconds); two running for the same
// project would let the later one overwrite the earlier one's result. A single queue serializes
// them, for the same reason as collector.ts's enqueue.
import { existsSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Account, Provider } from '../../core/types'
import type { ProviderDescriptor } from '../../core/providers/descriptor'
import type { ProjectUnderstanding, RecordExplanation, WorkRecord } from '../../core/understanding/types'
import type { GeneratorSettings } from '../../core/understanding/generatorSettings'
import type { SessionWorkUnit } from '../../core/workUnit/types'
import { sessionLabelOf } from '../../core/understanding/changeRecord'
import { buildRecordPrompt } from '../../core/understanding/prompt'
import type { Lang } from '../../core/i18n'
import { validateRecord } from '../../core/understanding/validate'
import { evidenceIdOf } from '../../core/understanding/evidence'
import type { UnderstandingStore } from './store'
import { runAgent } from './agent'

export interface PipelineDeps {
  store: UnderstandingStore
  /** 생성 계정을 찾는다. 없으면(지우거나 안 골랐으면) null — 그때는 생성하지 않는다 */
  accountOf: (accountId: string) => Account | null
  descriptors: Record<Provider, ProviderDescriptor>
  generator: () => GeneratorSettings
  /** The app's language, asked for at write-up time rather than held: the user can change it
   *  while a record is still being made, and the next one should follow. */
  lang: () => Lang
  now: () => string
  /** Commit subjects in a range, for the agent's material. Optional: a project that is not a
   *  repository has none, and a record is still worth writing without them. */
  readCommits?: (projectRoot: string, from: string | null, to: string | null) => Promise<string[]>
  /** 저장이 끝났다. **화면이 다시 읽는 방아쇠다** — 재생성은 배경에서 수십 초 걸려 끝나고,
   *  이것이 없으면 그 결과는 사용자가 프로젝트를 바꿔 돌아올 때까지 화면에 없다 */
  onChanged?: (projectRoot: string) => void
  log?: (m: string) => void
}

export interface RunRecordInput {
  runId: string
  jobName: string
  /** The Run's objective — what the user asked this job to achieve */
  objective: string
  at: string
  taskIds: string[]
  tasks: { title: string; outcome: string }[]
  /** Union of every task's filesModified. A Job's tasks report what they touched, so this does not
   *  need the git snapshot comparison a session's unit relies on. */
  changedFiles: string[]
  validation?: { status: 'passed' | 'failed' | 'unknown'; summary?: string }
}

export class UnderstandingPipeline {
  private chain: Promise<void> = Promise.resolve()

  constructor(private deps: PipelineDeps) {}

  /** 생성에 필요한 것이 다 있는가 — 없으면 그 사유가 곧 화면 문구다 */
  private agentContext():
    | { ok: true; ctx: { account: Account; descriptors: Record<Provider, ProviderDescriptor>; generator: GeneratorSettings } }
    | { ok: false; reason: string } {
    const g = this.deps.generator()
    if (!g.accountId) return { ok: false, reason: 'NO_GENERATOR_ACCOUNT' }
    const account = this.deps.accountOf(g.accountId)
    // 계정이 지워졌다. 설정에는 id 가 남아 있지만 고르지 않은 것과 같이 다룬다
    if (!account) return { ok: false, reason: 'NO_GENERATOR_ACCOUNT' }
    return { ok: true, ctx: { account, descriptors: this.deps.descriptors, generator: g } }
  }

  /** 저장하고 **화면에 알린다.** store.set 을 직접 부르지 않는 이유가 이 한 줄이다: 알림을
   *  빠뜨린 저장은 조용히 화면 밖에 남고, 사용자는 재생성이 실패한 것으로 읽는다. */
  private async write(projectRoot: string, u: ProjectUnderstanding): Promise<void> {
    await this.deps.store.set(projectRoot, u)
    this.deps.onChanged?.(projectRoot)
  }

  /** 큐. **거부하지 않는다** — 한 번의 생성 실패가 이후 모든 생성을 멈추게 하면 안 되고,
   *  부르는 쪽(수집기의 저장 경로)이 이 프로미스를 버려도 처리되지 않은 거부가 남지 않는다.
   *  workUnit/collector.ts 의 enqueue 와 같은 모양, 같은 이유다. */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    const run = async (): Promise<void> => {
      try {
        await fn()
      } catch (e) {
        this.deps.log?.(`understanding pipeline failed: ${String(e)}`)
      }
    }
    this.chain = this.chain.then(run, run)
    return this.chain
  }

  /** A work unit closed. **The only writer of records from a session** — nothing else may create
   *  one, which is what makes "nothing from before you turned tracking on" hold for the whole
   *  screen (design D2).
   *
   *  The caller does not wait: the returned promise never rejects (see enqueue), and the
   *  collector's own round must not be held up by an agent that takes minutes. */
  onUnitClosed(projectRoot: string, unit: SessionWorkUnit): Promise<void> {
    return this.enqueue(async () => {
      if (unit.status !== 'completed') return // spec §7 — an abandoned unit does not flow downstream
      const record: WorkRecord = {
        id: randomUUID(),
        at: unit.completedAt ?? unit.startedAt,
        source: { kind: 'session', sessionId: unit.sessionId, label: sessionLabelOf(unit.sessionId) },
        request: unit.title,
        changedFiles: [...unit.git.observedChangedFiles],
        git: { startHead: unit.git.startHead, endHead: unit.git.endHead ?? null },
        status: 'generating'
      }
      // **Saved before the agent runs.** The write-up takes minutes; a row that only appears when it
      // finishes leaves the screen looking like nothing happened, and the work is already done.
      await this.prepend(projectRoot, record)
      const commits = await this.commitsOf(projectRoot, record)
      await this.patch(projectRoot, record.id, (r) => ({ ...r, git: { ...r.git, commits } }))
      await this.fill(projectRoot, record.id, commits)
    })
  }

  /** A Job Run reached a terminal state. One Run is one record (design D3) — the user asked for one
   *  Run, so that is the boundary of one piece of work, and its tasks are material inside it rather
   *  than rows of their own. */
  onRunFinished(projectRoot: string, input: RunRecordInput): Promise<void> {
    return this.enqueue(async () => {
      const record: WorkRecord = {
        id: randomUUID(),
        at: input.at,
        source: { kind: 'job', runId: input.runId, jobName: input.jobName, taskIds: input.taskIds },
        request: input.objective,
        changedFiles: input.changedFiles,
        git: { startHead: null, endHead: null },
        validation: input.validation,
        jobTasks: input.tasks,
        status: 'generating'
      }
      await this.prepend(projectRoot, record)
      await this.fill(projectRoot, record.id, [])
    })
  }

  /** The user pressed [다시] on one record. Same path, minus the record creation — and it does
   *  overwrite a hand-edited write-up, because that is what pressing it means (§56 binds the
   *  background, not the user). */
  regenerate(projectRoot: string, recordId: string): Promise<void> {
    return this.enqueue(async () => {
      const cur = this.deps.store.get(projectRoot)?.records.find((r) => r.id === recordId)
      if (!cur) return
      await this.patch(projectRoot, recordId, (r) => ({ ...r, status: 'generating', reason: undefined }))
      await this.fill(projectRoot, recordId, cur.git.commits ?? [])
    })
  }

  /** The agent round trip and everything that hangs on its answer. */
  private async fill(projectRoot: string, recordId: string, commits: string[]): Promise<void> {
    const ready = this.agentContext()
    const cur = this.deps.store.get(projectRoot)?.records.find((r) => r.id === recordId)
    if (!cur) return
    if (!ready.ok) {
      await this.patch(projectRoot, recordId, (r) => ({ ...r, status: 'failed', reason: ready.reason }))
      return
    }
    const run = await runAgent({
      ...ready.ctx,
      cwd: projectRoot,
      prompt: buildRecordPrompt({
        request: cur.request,
        changedFiles: cur.changedFiles,
        commits,
        tasks: cur.source.kind === 'job' ? cur.jobTasks : undefined,
        validation: cur.validation,
        projectRoot,
        lang: this.deps.lang()
      }),
      log: this.deps.log
    })
    if (!run.ok) {
      await this.patch(projectRoot, recordId, (r) => ({ ...r, status: 'failed', reason: run.reason }))
      return
    }
    const v = validateRecord(run.value, isProjectFile(projectRoot))
    if (!v.ok) {
      await this.patch(projectRoot, recordId, (r) => ({ ...r, status: 'failed', reason: v.reason }))
      return
    }
    const e = v.value
    const explanation: RecordExplanation = {
      overview: e.overview,
      userVisibleChanges: e.userVisibleChanges,
      flow: e.flow,
      decisions: e.decisions.map((d) => ({
        id: randomUUID(),
        title: d.title,
        reason: d.reason,
        // 'agent' because this was read from code and inferred — spec §12 hangs the pill's color on
        // that distinction
        source: 'agent' as const,
        sourceLabel: d.sourceLabel,
        evidenceIds: d.evidenceIds
      })),
      implementation: e.implementation,
      evidence: e.evidencePaths.map((p) => ({
        id: evidenceIdOf(p),
        type: 'source-file' as const,
        label: p,
        path: p
      })),
      userEdited: false,
      generatedAt: this.deps.now()
    }
    await this.patch(projectRoot, recordId, (r) => ({
      ...r,
      explanation,
      status: e.needsReview ? 'needs-review' : 'ready',
      reason: e.needsReview ? e.needsReviewReason : undefined
    }))
  }

  private async commitsOf(projectRoot: string, r: WorkRecord): Promise<string[]> {
    if (!this.deps.readCommits) return []
    try {
      return await this.deps.readCommits(projectRoot, r.git.startHead, r.git.endHead)
    } catch {
      return [] // failing to read commits is not a reason to fail the record
    }
  }

  private prepend(projectRoot: string, record: WorkRecord): Promise<void> {
    const cur = this.deps.store.get(projectRoot)
    return this.write(projectRoot, { records: [record, ...(cur?.records ?? [])] })
  }

  /** **Reads the file again before writing.** The agent takes minutes, and in that time another
   *  unit can close or the user can edit. Writing back a snapshot taken before the round trip would
   *  drop whatever happened in between. A record that vanished is left alone. */
  private async patch(
    projectRoot: string,
    recordId: string,
    f: (r: WorkRecord) => WorkRecord
  ): Promise<void> {
    const cur = this.deps.store.get(projectRoot)
    if (!cur || !cur.records.some((r) => r.id === recordId)) return
    await this.write(projectRoot, {
      records: cur.records.map((r) => (r.id === recordId ? f(r) : r))
    })
  }
}

/** 저장소 **안에** 실제로 있는 경로인가.
 *
 *  **`path.join` 만으로는 부족하다:** `../outside/secret.ts` 는 프로젝트 밖으로 풀리는데도
 *  존재하므로 통과한다(실측). 그러면 근거 검증(§24-12)이 막으려던 바로 그것 — 근거 아닌 것을
 *  근거로 대는 일 — 이 통과하고, 그 경로는 화면에 뜨며 다음 재생성의 "여기서부터 읽어라"
 *  목록에도 실린다. 그래서 푼 뒤에 저장소 안인지 다시 묻는다. */
/** 저장소 안에 있고, **디렉터리가 아니라 파일**인가.
 *
 *  첫 분석이 기능마다 파일을 최소 하나 대야 하는 이유는 validate.ts 에 적혀 있다 — 여기서는 그
 *  물음에 fs 로 답할 뿐이다. insideProject 를 먼저 거쳐 저장소 밖을 배제한다. */
function isProjectFile(projectRoot: string): (p: string) => boolean {
  const inside = insideProject(projectRoot)
  return (p) => {
    if (!inside(p)) return false
    try {
      return statSync(path.resolve(projectRoot, p)).isFile()
    } catch {
      return false
    }
  }
}

function insideProject(projectRoot: string): (p: string) => boolean {
  return (p) => {
    const abs = path.resolve(projectRoot, p)
    const rel = path.relative(projectRoot, abs)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false
    return existsSync(abs)
  }
}

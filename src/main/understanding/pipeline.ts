// 작업 단위가 닫히면 그 변화를 설명으로 옮긴다 — 이 계획의 배선.
//
// **여기에는 규칙이 없다.** 판정은 전부 core 의 순수 함수가 하고(changeRecord · mapping ·
// prompt · validate), 이 파일은 순서를 잇고 저장한다. 그 갈래는 workUnit/collector.ts 와 같다.
//
// 흐름 (설계 §3):
//   완료된 Unit → ChangeSummary → 겹치는 기능 고르기 → 그 기능만 재생성 → understanding.json
//
// **한 번에 하나만 돈다.** 에이전트 실행은 비싸고(수십 초), 같은 프로젝트에 두 개가 겹치면
// 나중 것이 앞 것의 결과를 덮는다. 큐 하나로 직렬화하는 것은 collector 의 enqueue 와 같은 이유다.
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
  now: () => string
  /** Commit subjects in a range, for the agent's material. Optional: a project that is not a
   *  repository has none, and a record is still worth writing without them. */
  readCommits?: (projectRoot: string, from: string | null, to: string | null) => Promise<string[]>
  /** 저장이 끝났다. **화면이 다시 읽는 방아쇠다** — 재생성은 배경에서 수십 초 걸려 끝나고,
   *  이것이 없으면 그 결과는 사용자가 프로젝트를 바꿔 돌아올 때까지 화면에 없다 */
  onChanged?: (projectRoot: string) => void
  log?: (m: string) => void
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
      if (unit.status !== 'completed') return // 스펙 §7 — 버려진 Unit 은 하류로 흐르지 않는다
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
      record.git.commits = commits
      await this.fill(projectRoot, record.id, commits)
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
        projectRoot
      }),
      log: this.deps.log
    })
    if (!run.ok) {
      await this.patch(projectRoot, recordId, (r) => ({ ...r, status: 'failed', reason: run.reason }))
      return
    }
    const v = validateRecord(run.value, insideProject(projectRoot))
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
        // 코드를 읽고 추론한 것이므로 'agent' 다 — 스펙 §12 가 그 구분에 알약 색을 걸었다
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
      return [] // 커밋을 못 읽는 것은 기록을 못 쓸 이유가 아니다
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

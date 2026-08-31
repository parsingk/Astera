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
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Account, Provider } from '../../core/types'
import type { ProviderDescriptor } from '../../core/providers/descriptor'
import type { SessionWorkUnit } from '../../core/workUnit/types'
import type {
  ChangeSummary,
  FeatureExplanation,
  ProjectFeature,
  ProjectUnderstanding
} from '../../core/understanding/types'
import type { GeneratorSettings } from '../../core/understanding/generatorSettings'
import { changeSummaryOf } from '../../core/understanding/changeRecord'
import { mapFilesToFeatures } from '../../core/understanding/mapping'
import { evidenceIdOf } from '../../core/understanding/evidence'
import { buildDiscoverPrompt, buildExplainPrompt } from '../../core/understanding/prompt'
import { sketchText } from '../../core/understanding/context'
import { validateDiscovery, validateExplanation } from '../../core/understanding/validate'
import { runAgent } from './agent'
import { collectSketch } from './collectContext'
import type { UnderstandingStore } from './store'

/** 사이드바 아래 "최근 변경" 이 보여 주는 줄 수. 그보다 오래된 것은 잘라 낸다 —
 *  이 배열은 프로젝트마다 무한히 자랄 수 있고, 읽는 자리는 세 줄뿐이다 */
const RECENT_LIMIT = 20

/** 기능 하나의 페인 아래에 서는 줄 수. 프로젝트 전체 목록보다 짧다 — 한 기능의 이력은 그 기능을
 *  열었을 때만 보이고, 그 자리에서 필요한 것은 "최근에 왜 바뀌었나" 몇 줄이다 */
const FEATURE_RECENT_LIMIT = 5

/** explain() 이 돌려주는 것. onUnitClosed 와 regenerate 가 같은 값을 받아 같은 방식으로 얹는다 */
type Built =
  | {
      ok: true
      value: Omit<FeatureExplanation, 'featureId' | 'userEdited' | 'generatedAt'>
      needsReview: boolean
      needsReviewReason?: string
    }
  | { ok: false; reason: string }

export interface PipelineDeps {
  store: UnderstandingStore
  /** 생성 계정을 찾는다. 없으면(지우거나 안 골랐으면) null — 그때는 생성하지 않는다 */
  accountOf: (accountId: string) => Account | null
  descriptors: Record<Provider, ProviderDescriptor>
  generator: () => GeneratorSettings
  now: () => string
  /** 저장이 끝났다. **화면이 다시 읽는 방아쇠다** — 재생성은 배경에서 수십 초 걸려 끝나고,
   *  이것이 없으면 그 결과는 사용자가 프로젝트를 바꿔 돌아올 때까지 화면에 없다 */
  onChanged?: (projectRoot: string) => void
  log?: (m: string) => void
}

export class UnderstandingPipeline {
  private chain: Promise<void> = Promise.resolve()

  constructor(private deps: PipelineDeps) {}

  /** 완료된 Unit 하나가 도착했다. **부르는 쪽은 기다리지 않아도 된다** — 돌려주는 프로미스는
   *  거부하지 않는다(아래 enqueue). 수집기의 저장이 이 생성 때문에 늦어져서는 안 된다. */
  onUnitClosed(projectRoot: string, unit: SessionWorkUnit): Promise<void> {
    return this.enqueue(async () => {
      const summary = changeSummaryOf(unit, randomUUID())
      if (!summary) return // completed 가 아닌 Unit — 스펙 §7

      const u = this.deps.store.get(projectRoot)
      // 아직 분석하지 않은 프로젝트는 기능 목록이 없다. **최근 변경만 남긴다** — 기능을
      // 지어내지 않고, 사용자가 "프로젝트 분석" 을 누르면 그때 목록이 생긴다
      const features = u?.features ?? []
      const explanations = u?.explanations ?? {}

      const targets = mapFilesToFeatures(
        unit.git.observedChangedFiles,
        features.map((f) => ({
          featureId: f.id,
          paths: (explanations[f.id]?.implementation ?? []).map((i) => i.path)
        }))
      )
      // 겹치는 기능이 여럿이면 가장 많이 겹친 하나만 다시 쓴다 — 한 변화가 여러 설명을 동시에
      // 갈아엎으면 무엇이 왜 바뀌었는지가 사라지고, 에이전트 실행도 그만큼 곱해진다
      const featureId = targets[0]
      const feature = features.find((f) => f.id === featureId)
      if (feature) summary.featureName = feature.name

      const next: ProjectUnderstanding = {
        features: [...features],
        explanations: { ...explanations },
        analyzedAt: u?.analyzedAt,
        recentChanges: [summary, ...(u?.recentChanges ?? [])].slice(0, RECENT_LIMIT)
      }

      if (!feature) {
        // 어느 기능에도 안 걸린다 — 기록만 남기고 끝낸다
        await this.write(projectRoot, next)
        return
      }

      const prev = explanations[feature.id]
      // **그 기능의 줄에도 남긴다.** 사이드바 아래 목록은 프로젝트 전체의 것이라, 기능 하나를
      // 열었을 때 "이 기능이 최근에 왜 바뀌었나"에는 답하지 못한다. 생성의 성패와 무관하게
      // 남기는 이유: 변화는 실제로 일어났고, 그것이 설명에 실렸는지는 상태가 따로 말한다.
      if (prev)
        next.explanations[feature.id] = {
          ...prev,
          recentChanges: [summary, ...prev.recentChanges].slice(0, FEATURE_RECENT_LIMIT)
        }

      // **사람이 고친 설명은 덮지 않는다** (스펙 §56). 대신 "갱신할 것이 있다"고만 표시한다
      if (prev?.userEdited) {
        this.mark(next, feature.id, 'update-available')
        await this.write(projectRoot, next)
        return
      }

      // 여기서부터가 에이전트 왕복이다. 먼저 "만드는 중"을 저장해 화면이 그것을 보여 준다
      this.mark(next, feature.id, 'generating')
      await this.write(projectRoot, next)

      const built = await this.explain(projectRoot, feature, prev?.implementation.map((i) => i.path) ?? [], [
        summary.body
      ])
      await this.applyBuilt(projectRoot, feature.id, built, true)
    })
  }

  /** 사용자가 기능 하나의 [다시] 를 눌렀다.
   *
   *  **결과를 기다리지 않는다** — analyzeProject 와 갈리는 자리다. 저쪽은 목록 자체가 없어 기다리는
   *  동안 보여 줄 것이 없지만, 여기는 그릴 줄이 이미 있어 그 자리에서 "생성 중"을 보여 줄 수 있다.
   *  끝나면 저장이 화면으로 밀린다(onChanged).
   *
   *  **사람이 고친 설명도 덮는다.** 배경 재생성과 갈리는 자리다: 그쪽은 아무도 부탁하지 않은
   *  일이라 §56 이 막지만, 이 버튼은 사용자가 "다시 만들어라"라고 말한 것이다 — `update-available`
   *  줄이 새 설명을 받는 유일한 길이 이 버튼이다. */
  regenerate(projectRoot: string, featureId: string): Promise<void> {
    return this.enqueue(async () => {
      const u = this.deps.store.get(projectRoot)
      const feature = u?.features.find((f) => f.id === featureId)
      if (!u || !feature) return

      const prev = u.explanations[featureId]
      const next: ProjectUnderstanding = {
        ...u,
        features: [...u.features],
        explanations: { ...u.explanations }
      }
      this.mark(next, featureId, 'generating')
      await this.write(projectRoot, next)

      const built = await this.explain(
        projectRoot,
        feature,
        prev?.implementation.map((i) => i.path) ?? [],
        // 이 기능에 쌓인 변화를 그대로 재료로 준다 — 무엇이 왜 바뀌었는지가 설명에 실려야 한다
        (prev?.recentChanges ?? []).map((c) => c.body)
      )
      await this.applyBuilt(projectRoot, featureId, built, false)
    })
  }

  /** 에이전트가 답한 뒤 얹고 저장한다. 배경 재생성과 [다시] 버튼이 같은 일을 한다 —
   *  갈리는 것은 `respectUserEdited` 하나뿐이다(위 regenerate 의 주석). */
  private async applyBuilt(
    projectRoot: string,
    featureId: string,
    built: Built,
    respectUserEdited: boolean
  ): Promise<void> {
    // 에이전트가 도는 동안 저장 파일이 바뀌었을 수 있다(사용자가 다른 프로젝트를 분석했거나
    // 다음 Unit 이 닫혔다). **그때의 값을 다시 읽어 그 위에 얹는다** — 우리가 들고 있던
    // 스냅샷으로 덮으면 그 사이의 변화가 사라진다
    const fresh = this.deps.store.get(projectRoot)
    if (!fresh) return
    const merged: ProjectUnderstanding = {
      features: [...fresh.features],
      explanations: { ...fresh.explanations },
      analyzedAt: fresh.analyzedAt,
      recentChanges: fresh.recentChanges
    }

    // **가드를 여기서 한 번 더 본다.** 에이전트 실행 전의 검사만으로는 부족하다: 그 사이
    // 30~180초가 흐르고, 그동안 사용자가 이 기능의 설명을 손으로 고쳤을 수 있다. 기능이
    // 사라진 경우(재분석이 이름을 바꿨다)도 여기서 걸러야 한다 — 죽은 id 에 쓰면 그 설명은
    // 아무도 가리키지 않는 자리에 남고 상태는 "생성 중"에 갇힌다.
    const living = merged.features.find((f) => f.id === featureId)
    if (!living) {
      this.deps.log?.(`understanding: feature ${featureId} vanished during generation — 결과를 버린다`)
      await this.write(projectRoot, merged)
      return
    }
    const prev = merged.explanations[featureId]
    if (respectUserEdited && prev?.userEdited) {
      this.mark(merged, featureId, 'update-available')
      await this.write(projectRoot, merged)
      return
    }

    if (built.ok) {
      merged.explanations[featureId] = {
        featureId,
        ...built.value,
        // 기능의 최근 변경은 설명이 아니라 이력이다 — 새 설명이 그것을 지워서는 안 된다
        recentChanges: prev?.recentChanges ?? [],
        userEdited: false,
        generatedAt: this.deps.now()
      }
      this.mark(merged, featureId, built.needsReview ? 'needs-review' : 'up-to-date', built.needsReviewReason)
    } else {
      this.mark(merged, featureId, 'generation-failed', built.reason)
    }
    await this.write(projectRoot, merged)
  }

  /** 첫 분석 — 기능 목록 초안을 만든다 (스펙 §21). 설명은 만들지 않는다.
   *
   *  **이 하나는 부르는 쪽이 결과를 본다** — 사용자가 버튼을 눌러 기다리는 일이라, 실패하면
   *  그 사유가 화면에 떠야 한다. 그래서 큐가 값을 실어 나른다: 배경 재생성과 같은 줄에 서되
   *  결과는 부르는 쪽으로 돌아간다.
   *
   *  **같은 줄에 서야 하는 이유:** 이 함수는 기능의 id 를 새로 만든다. 배경 재생성이 도는
   *  동안 그것이 끼어들면 재생성이 들고 있던 id 가 죽고, 그 결과는 아무도 가리키지 않는 자리에
   *  쓰이며 상태는 generating 에 갇힌다(그쪽에도 방어가 있지만, 애초에 겹치지 않는 편이 낫다).
   *  이 파일 머리주석이 "한 번에 하나만 돈다"고 적은 것이 이 뜻이다. */
  analyzeProject(projectRoot: string): Promise<{ ok: true; count: number } | { ok: false; reason: string }> {
    let result: { ok: true; count: number } | { ok: false; reason: string } = {
      ok: false,
      reason: 'UNKNOWN'
    }
    // enqueue 는 거부하지 않는다 — 던진 예외는 그쪽이 삼켜 로그로 남기고, 여기서는 위의
    // 초깃값이 그대로 돌아간다. 사용자는 "알 수 없는 이유로 실패"를 보고 다시 누를 수 있다
    return this.enqueue(async () => {
      result = await this.runAnalyze(projectRoot)
    }).then(() => result)
  }

  private async runAnalyze(
    projectRoot: string
  ): Promise<{ ok: true; count: number } | { ok: false; reason: string }> {
    const ready = this.agentContext()
    if (!ready.ok) return ready

    const run = await runAgent({
      ...ready.ctx,
      cwd: projectRoot,
      // 재료를 먼저 모은다 (스펙 §29) — 이것이 없으면 에이전트가 저장소를 하나씩 열어 본다
      prompt: buildDiscoverPrompt(projectRoot, sketchText(await collectSketch(projectRoot))),
      log: this.deps.log
    })
    if (!run.ok) return { ok: false, reason: run.reason }

    const v = validateDiscovery(run.value, insideProject(projectRoot), isProjectFile(projectRoot))
    if (!v.ok) return { ok: false, reason: v.reason }

    const now = this.deps.now()
    const prev = this.deps.store.get(projectRoot)

    // **이름을 한 번만 쓴다.** 초안에 같은 이름이 둘 오면(에이전트가 실제로 그럴 수 있다) 둘 다
    // 같은 옛 id 를 물려받아 하나로 뭉개지는데, 화면에는 "2개를 찾았다"고 뜨고 사이드바의 두 줄이
    // 같은 곳을 가리킨다. 먼저 온 것이 이름을 가진다 — 뒤엣것은 새 id 를 받아 따로 선다.
    const taken = new Set<string>()
    const features: ProjectFeature[] = v.value.features.map((f) => {
      const old = taken.has(f.name) ? undefined : prev?.features.find((x) => x.name === f.name)
      taken.add(f.name)
      return {
        id: old?.id ?? randomUUID(),
        name: f.name,
        summary: f.summary,
        status: old && prev?.explanations[old.id] ? old.status : 'needs-review',
        updatedAt: old?.updatedAt ?? now,
        evidenceCount: old?.evidenceCount ?? 0,
        staleReason: old?.staleReason
      } satisfies ProjectFeature
    })

    // **주인 없는 설명은 걷는다.** 기능의 이름이 바뀌면 옛 id 는 어느 줄도 가리키지 않는데,
    // 그대로 두면 파일이 영영 자라고 그 안의 userEdited 설명은 사람이 다시 꺼낼 길이 없다.
    // 잃는 것을 줄이려고 **먼저 이어 붙이기를 시도한다**: 옛 기능 중 짝을 못 찾은 것이 하나이고
    // 새 기능 중 설명이 없는 것도 하나뿐이면, 그 둘은 이름이 바뀐 같은 기능으로 본다.
    const carried = new Set(features.map((f) => f.id))
    const orphanIds = Object.keys(prev?.explanations ?? {}).filter((id) => !carried.has(id))
    const explanations = { ...(prev?.explanations ?? {}) }
    const fresh = features.filter((f) => !explanations[f.id])
    if (orphanIds.length === 1 && fresh.length === 1) {
      const moved = explanations[orphanIds[0]]
      explanations[fresh[0].id] = { ...moved, featureId: fresh[0].id }
      this.deps.log?.(
        `understanding: 설명을 ${orphanIds[0]} → ${fresh[0].id} 로 옮겼다 (이름이 바뀐 것으로 본다)`
      )
    }
    for (const id of orphanIds) if (!carried.has(id)) delete explanations[id]

    const next: ProjectUnderstanding = {
      features,
      explanations,
      analyzedAt: now,
      recentChanges: prev?.recentChanges ?? []
    }
    // 초안이 준 구현 경로를 그 기능의 설명 자리에 심어 둔다 — 다음 매핑과 재생성이 그것을 읽는다
    for (let i = 0; i < v.value.features.length; i++) {
      const f = next.features[i]
      if (next.explanations[f.id]) continue
      next.explanations[f.id] = {
        featureId: f.id,
        overview: v.value.features[i].summary,
        userFlow: [],
        failureFlows: [],
        keyDecisions: [],
        implementation: v.value.features[i].implementationPaths.map((p) => ({ role: f.name, path: p })),
        recentChanges: [],
        evidence: [],
        userEdited: false,
        generatedAt: now
      }
    }
    await this.write(projectRoot, next)
    return { ok: true, count: next.features.length }
  }

  /** 기능 하나의 설명을 만든다 */
  private async explain(
    projectRoot: string,
    feature: ProjectFeature,
    implementationPaths: string[],
    recentChangeBodies: string[]
  ): Promise<Built> {
    const ready = this.agentContext()
    if (!ready.ok) return ready

    const run = await runAgent({
      ...ready.ctx,
      cwd: projectRoot,
      prompt: buildExplainPrompt({
        feature: { id: feature.id, name: feature.name, summary: feature.summary },
        implementationPaths,
        recentChangeBodies,
        projectRoot
      }),
      log: this.deps.log
    })
    if (!run.ok) return run

    const v = validateExplanation(run.value, insideProject(projectRoot))
    if (!v.ok) return { ok: false, reason: v.reason }

    const e = v.value
    return {
      ok: true,
      needsReview: e.needsReview,
      needsReviewReason: e.needsReviewReason,
      value: {
        overview: e.overview,
        userFlow: e.userFlow,
        failureFlows: e.failureFlows,
        keyDecisions: e.keyDecisions.map((d) => ({
          id: randomUUID(),
          title: d.title,
          reason: d.reason,
          // 출처를 가릴 근거가 없다 — 에이전트가 코드를 읽고 추론한 것이므로 'agent' 다.
          // 스펙 §12 가 그 구분에 알약 색을 걸었다: 추정을 결정과 같은 무게로 보여 주지 않는다
          source: 'agent' as const,
          sourceLabel: d.sourceLabel,
          evidenceIds: d.evidenceIds
        })),
        implementation: e.implementation,
        recentChanges: [],
        // **id 를 경로에서 만든다** — 무작위로 두면 재생성마다 값이 바뀌어, 그 id 를 들고 있던
        // 최근 변경 줄이 다음 생성의 어떤 단계와도 겹치지 않는다(evidence.ts 의 주석)
        evidence: e.evidencePaths.map((p) => ({
          id: evidenceIdOf(p),
          type: 'source-file' as const,
          label: p,
          path: p
        }))
      }
    }
  }

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

  private mark(
    u: ProjectUnderstanding,
    featureId: string,
    status: ProjectFeature['status'],
    reason?: string
  ): void {
    const i = u.features.findIndex((f) => f.id === featureId)
    if (i < 0) return
    u.features[i] = {
      ...u.features[i],
      status,
      updatedAt: this.deps.now(),
      evidenceCount: u.explanations[featureId]?.evidence.length ?? u.features[i].evidenceCount,
      staleReason: reason
    }
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

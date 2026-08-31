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
import path from 'node:path'
import type { Account, Provider } from '../../core/types'
import type { ProviderDescriptor } from '../../core/providers/descriptor'
import type { ProjectUnderstanding } from '../../core/understanding/types'
import type { GeneratorSettings } from '../../core/understanding/generatorSettings'
import type { UnderstandingStore } from './store'

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

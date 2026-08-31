// 두 CLI 의 모델 응답 → ModelDescriptor. **순수하다** — 프로세스는 main 이 띄우고 여기는
// 받은 값만 바꾼다. 그래서 응답 모양이 바뀌었을 때의 동작이 프로세스 없이 전수 테스트된다.
//
// node: import 없음.
import type { ModelDescriptor } from './types'

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

const strArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length > 0 ? (v as string[]) : undefined

/** codex 의 강도 목록은 **문자열 배열이 아니라 `{reasoningEffort, description}` 객체 배열**이다
 *  (실측 2026-08-30 — `[{"reasoningEffort":"low","description":"Fast responses…"}, …]`).
 *  claude 쪽은 그냥 문자열 배열이라 둘을 같은 헬퍼로 읽을 수 없다. 설명은 버린다 — 지금 화면이
 *  강도를 고르는 자리에 한 줄짜리 이름만 쓰기 때문이고, 필요해지면 그때 늘린다. */
const effortArray = (v: unknown): string[] | undefined => {
  if (!Array.isArray(v) || v.length === 0) return undefined
  const out: string[] = []
  for (const e of v) {
    if (typeof e === 'string') out.push(e)
    else if (isObj(e) && typeof e.reasoningEffort === 'string') out.push(e.reasoningEffort)
  }
  return out.length > 0 ? out : undefined
}

/** claude 의 `control_request/initialize` 응답에 실려 오는 `models` 배열.
 *
 *  실측(2026-08-30, claude 네이티브): `value` · `resolvedModel` · `displayName` · `description` ·
 *  `supportsEffort` · `supportedEffortLevels` · `supportsAdaptiveThinking` · `supportsFastMode` ·
 *  `supportsAutoMode`. 5개가 왔고 그중 하나가 `value: 'default'` 였다 —
 *  **그 줄이 "이 계정의 기본"이다.** id 로는 `value` 를 쓴다(`--model` 이 받는 값이다).
 *
 *  모양이 어긋난 항목은 조용히 건너뛴다 — 하나가 이상하다고 목록 전체를 버리면 사용자는
 *  드롭다운을 통째로 잃는다. 반대로 빈 목록은 부르는 쪽이 실패로 다룬다. */
export function parseClaudeModels(raw: unknown): ModelDescriptor[] {
  if (!Array.isArray(raw)) return []
  const out: ModelDescriptor[] = []
  for (const m of raw) {
    if (!isObj(m)) continue
    const id = str(m.value)
    if (!id) continue
    out.push({
      provider: 'claude',
      id,
      name: str(m.displayName) ?? id,
      description: str(m.description),
      isDefault: id === 'default',
      effortLevels: m.supportsEffort === true ? strArray(m.supportedEffortLevels) : undefined
    })
  }
  return out
}

/** codex `app-server` 의 `model/list` 응답 — `{ data, nextCursor }` 의 `data`.
 *
 *  실측(2026-08-30): `id` · `model` · `displayName` · `description` ·
 *  `supportedReasoningEfforts` · `defaultReasoningEffort` · `hidden` · `isDefault`. 6개가 왔다.
 *  `id` 와 `model` 이 함께 오는데 `-m` 에 넘길 값은 `model` 이다 — `id` 는 서버 쪽 식별자라
 *  둘이 갈릴 수 있고, 갈리면 CLI 가 모르는 이름을 받는다. `model` 이 없으면 `id` 로 저하한다.
 *
 *  `hidden: true` 는 내부용이다(실측에서 `gpt-reserve` · `codex-auto-review` 둘). 부르는 쪽이
 *  `includeHidden: false` 로 물으므로 보통은 오지 않지만, 와도 여기서 거른다 — 사용자가 고를
 *  대상이 아니다. */
export function parseCodexModels(raw: unknown): ModelDescriptor[] {
  if (!Array.isArray(raw)) return []
  const out: ModelDescriptor[] = []
  for (const m of raw) {
    if (!isObj(m)) continue
    if (m.hidden === true) continue
    const id = str(m.model) ?? str(m.id)
    if (!id) continue
    out.push({
      provider: 'codex',
      id,
      name: str(m.displayName) ?? id,
      description: str(m.description),
      isDefault: m.isDefault === true,
      effortLevels: effortArray(m.supportedReasoningEfforts),
      defaultEffort: str(m.defaultReasoningEffort)
    })
  }
  return out
}

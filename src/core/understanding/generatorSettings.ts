// 설명을 누가·무엇으로 만드는가 — 설정 하나에 묶인 세 값.
//
// **셋이 함께 움직이므로 한 값이다.** 계정을 바꾸면 그 계정에 없는 모델 이름이 남아 있어서는
// 안 되고, 모델을 바꾸면 그 모델이 안 받는 강도가 남아 있어서는 안 된다. 저장을 셋으로 쪼개면
// 그 불변식을 지킬 자리가 사라진다.
//
// node: import 없음 — 렌더러(설정 화면)와 main(파이프라인)이 함께 읽는다.

export interface GeneratorSettings {
  /** 어느 계정으로 돌릴 것인가. **없으면 생성하지 않는다** — 지정 전에는 조용히 아무것도 하지
   *  않는 대신 화면이 그 사실을 말한다(설계 D2). 계정이 지워지면 이 id 는 남지만, 부르는 쪽이
   *  계정 목록에서 못 찾으면 지정되지 않은 것과 같이 다룬다 */
  accountId?: string
  /** CLI 의 `--model`/`-m` 에 넘길 값. **없으면 그 CLI 의 기본 모델이다** — 지금 세션을 띄우는
   *  방식과 같다(어디에서도 모델을 지정하지 않는다) */
  model?: string
  /** 추론 강도. 모델이 받을 때만 뜻이 있다 */
  effort?: string
}

const str = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t === '' ? undefined : t
}

/** 사용자가 손으로 고칠 수 있는 파일에서 읽는다 — 모양이 아니면 "지정되지 않음"이다.
 *  빈 문자열은 없는 것과 같이 본다: 입력칸을 비운 것이 곧 "기본값을 쓰겠다"이기 때문이다. */
export function readGeneratorSettings(v: unknown): GeneratorSettings {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return {}
  const o = v as Record<string, unknown>
  const out: GeneratorSettings = {}
  const accountId = str(o.accountId)
  if (accountId) out.accountId = accountId
  const model = str(o.model)
  if (model) out.model = model
  const effort = str(o.effort)
  if (effort) out.effort = effort
  return out
}

/** 저장할 값. 비어 있으면 `undefined` 를 돌려 **파일에 키 자체를 남기지 않는다** —
 *  이 저장소가 falsy 를 빼는 규칙(persist 의 주석) 그대로다 */
export function writableGeneratorSettings(s: GeneratorSettings): GeneratorSettings | undefined {
  const out = readGeneratorSettings(s)
  return out.accountId || out.model || out.effort ? out : undefined
}

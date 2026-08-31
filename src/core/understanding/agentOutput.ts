// 두 CLI 의 비대화형 출력에서 **에이전트가 말한 본문**만 꺼낸다.
//
// 모양이 다르다(실측 2026-08-30):
//   claude — `--output-format json` 이 한 덩어리 JSON 을 주고 본문은 `result` 다.
//            `is_error: true` 면 그 `result` 는 오류 문구다.
//   codex  — `exec --json` 이 줄마다 이벤트를 주고, 본문은 마지막
//            `item.completed` 중 `item.type === 'agent_message'` 의 `text` 다.
//            (`turn.completed` 는 사용량만 싣는다.)
//
// **본문에서 JSON 을 꺼내는 것까지가 이 모듈의 일이다.** 계약이 "펜스 없이 JSON 하나"를
// 요구해도 모델은 종종 ```json 펜스를 두르거나 앞뒤에 한 줄을 붙인다. 그것 때문에 설명 생성이
// 통째로 실패하는 것은 아깝고, 펜스를 벗기는 것은 추측이 아니라 되돌리기다.
//
// node: import 없음 — 프로세스는 main 이 띄우고 여기는 받은 문자열만 본다.

export type AgentOutput = { ok: true; text: string } | { ok: false; reason: string }

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** claude `-p --output-format json` 의 stdout */
export function readClaudeOutput(stdout: string): AgentOutput {
  let j: unknown
  try {
    j = JSON.parse(stdout)
  } catch {
    return { ok: false, reason: 'claude 의 출력이 JSON 이 아니다' }
  }
  if (!isObj(j)) return { ok: false, reason: 'claude 의 출력이 객체가 아니다' }
  const text = typeof j.result === 'string' ? j.result : ''
  if (j.is_error === true) return { ok: false, reason: `claude 가 오류로 끝났다: ${text.slice(0, 200)}` }
  if (text.trim() === '') return { ok: false, reason: 'claude 가 빈 답을 줬다' }
  return { ok: true, text }
}

/** codex `exec --json` 의 stdout — 줄마다 이벤트 */
export function readCodexOutput(stdout: string): AgentOutput {
  let last: string | null = null
  for (const line of stdout.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    let e: unknown
    try {
      e = JSON.parse(t)
    } catch {
      continue // codex 는 훅 로그 같은 비JSON 줄을 섞는다(실측)
    }
    if (!isObj(e) || e.type !== 'item.completed' || !isObj(e.item)) continue
    // 마지막 것을 쓴다 — 에이전트가 중간에 여러 번 말할 수 있고, 결론은 마지막이다
    if (e.item.type === 'agent_message' && typeof e.item.text === 'string') last = e.item.text
  }
  if (last === null || last.trim() === '') return { ok: false, reason: 'codex 가 답을 주지 않았다' }
  return { ok: true, text: last }
}

/** 본문에서 JSON 객체 하나를 꺼낸다. 펜스와 앞뒤 잡담을 벗긴다 */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  const t = text.trim()
  // ```json … ``` 또는 ``` … ```
  const fenced = t.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/)
  const body = fenced ? fenced[1] : t
  const direct = tryParse(body)
  if (direct !== undefined) return { ok: true, value: direct }
  // 앞뒤에 한 줄씩 붙은 경우 — 첫 `{` 부터 마지막 `}` 까지를 잘라 본다. **그 이상 추측하지
  // 않는다**: 여기서 실패하면 계약을 못 지킨 출력이고, 그것은 검증기가 거부할 일이다
  const s = body.indexOf('{')
  const e = body.lastIndexOf('}')
  if (s >= 0 && e > s) {
    const sliced = tryParse(body.slice(s, e + 1))
    if (sliced !== undefined) return { ok: true, value: sliced }
  }
  return { ok: false, reason: '답에서 JSON 객체를 찾지 못했다' }
}

function tryParse(s: string): unknown | undefined {
  try {
    const v: unknown = JSON.parse(s)
    return isObj(v) ? v : undefined
  } catch {
    return undefined
  }
}

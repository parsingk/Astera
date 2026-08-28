// For the Slack turn-completion notification — pulls the last agent message out of the tail of a codex
// rollout (jsonl). Pure module: reading the file is the caller's job (readFileTail in main's
// SlackNotifier). Same role and the same defensive parsing rules as extractLastTurnAssistantText in
// transcript.ts, which does this for claude — but only the **last** message. Whether a codex turn
// splits its text across several message records the way claude does (measured: 49.7% of claude turns
// leave two or more segments, see extractLastTurnAssistantText) has not been measured, so this side is
// deliberately left alone rather than changed on the strength of the claude finding.

/** rollout jsonl 꼬리 문자열에서 **에이전트의 마지막 메시지** 본문. 없으면 null. 꼬리는 파일
 *  중간부터 읽으므로 잘린 첫 줄은 JSON.parse 실패로 자연히 건너뛴다.
 *
 *  **`event_msg/agent_message` 가 아니라 `response_item/message` 를 읽는다.** codex 가 앞의 것을
 *  더 이상 쓰지 않으면서 Slack 알림의 본문이 사라졌고, 사용자에게는 "응답 완료" 한 줄만 갔다
 *  (실측 2026-08-29: 최근 rollout 넷에 `agent_message` 가 0건, `response_item/message` 는 표본 열
 *  개 전부에 존재). 같은 전환을 codex 대화 읽기 쪽도 함께 했다 — 그 판정의 근거와 중복 문제는
 *  core/history/codexParser.ts 의 eventMessage 주석에 적혀 있다.
 *
 *  **사용자 쪽 wrapper 필터는 쓰지 않는다.** 그것은 사용자 입력에 섞여 오는 `<environment_context>`
 *  류를 걸러내는 것이고, 에이전트 메시지에는 해당하지 않는다.
 *
 *  claude 쪽처럼 여러 조각을 이어 붙이지 않는다(transcript.ts 의 extractLastTurnAssistantText 는
 *  한 턴이 두 조각 이상으로 갈리는 것을 실측 49.7% 로 확인해 그렇게 한다). codex 가 그런지는 재
 *  본 적이 없으므로, 저쪽 실측을 근거로 이쪽을 바꾸지 않는다 — 한 레코드의 `content` 블록들은
 *  이어 붙이지만 레코드 사이는 이어 붙이지 않는다. */
export function extractLastAgentMessage(tail: string): string | null {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      continue // ignore a truncated first line or a broken line
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) continue
    const o = obj as Record<string, unknown>
    if (o.type !== 'response_item') continue
    const p = o.payload
    if (p === null || typeof p !== 'object' || Array.isArray(p)) continue
    const pp = p as Record<string, unknown>
    if (pp.type !== 'message' || pp.role !== 'assistant') continue
    // 블록 유형이 방향에 따라 다르므로(나가는 것은 `output_text`) 유형으로 고르지 않고 문자열
    // `text` 가 있는 블록을 전부 받는다 — codexParser 의 contentText 와 같은 규칙이다.
    const content = pp.content
    let out = ''
    if (typeof content === 'string') out = content
    else if (Array.isArray(content))
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue
        const t = (block as { text?: unknown }).text
        if (typeof t === 'string') out += t
      }
    const text = out.trim()
    if (text) return text
  }
  return null
}

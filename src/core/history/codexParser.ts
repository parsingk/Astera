import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { TranscriptMessage } from '../types'
import { lastTurns, PREVIEW_TURNS, READ_BUFFER_MAX, toTitle, type TranscriptResumeMaterial } from './parser'

/** Extracts the session uuid from a codex rollout filename (rollout-<ts>-<uuid>.jsonl) */
export const ROLLOUT_UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

export interface CodexMeta {
  sessionId: string | null
  cwd: string | null
  title: string | null
  /** What created this rollout, from `session_meta.source`. Measured 2026-08-31 on a live account:
   *  a session a person opened reads `"cli"` (with `originator: "codex-tui"`), while a one-shot
   *  `codex exec` run reads `"exec"` (`originator: "codex_exec"`).
   *
   *  This app never spawns a session through `exec` — it attaches a terminal to the interactive CLI —
   *  so an `exec` rollout is never a user's session. It is this app's own explanation generator,
   *  running in the same account and the same folder. null when the field is absent (an older codex),
   *  and a null is never treated as exec: losing a real session costs far more than showing an extra
   *  row. */
  source: string | null
}

/** 대화 메시지 하나를 rollout 한 줄에서 뽑는다. 그 줄이 메시지가 아니면 null(방어적 파싱).
 *
 *  **`event_msg/user_message`·`agent_message` 가 아니라 `response_item/message` 를 읽는다.**
 *  예전에는 앞의 둘을 읽었고, codex 가 그 둘을 더 이상 쓰지 않게 되면서 **이 앱의 codex 대화 읽기
 *  전부가 눈을 잃었다** — 히스토리 제목·미리보기·읽지 않은 표시·Smart Resume 브리핑, 그리고 Slack
 *  본문(core/slack/codexTranscript.ts 가 같은 전환을 겪었다).
 *
 *  **실측(2026-08-29, 이 컴퓨터의 rollout 최근 10개).** `event_msg/agent_message` 는 08-28 17:00
 *  이후 파일 넷에서 **0** 이고 `user_message` 는 그보다 앞선 파일에서도 이미 0 이다. 반면
 *  `response_item/message` 는 표본 **열 개 전부**에 있었고, 구 형식 파일에서는 개수가 옛 레코드보다
 *  많거나 같았다(예: 20/20, 226/58). 그래서 이것만 읽으면 두 형식이 모두 덮이고 **중복도 없다** —
 *  둘을 함께 읽으면 구 형식 파일에서 같은 메시지가 두 번 세어진다.
 *
 *  **`developer` 롤은 대화가 아니다.** 스킬 지시문과 다중 에이전트 안내가 그 롤로 들어온다(실측:
 *  20KB 짜리 `<skills_instructions>` 가 그 자리다). 사람도 에이전트도 하지 않은 말이므로 뺀다.
 *
 *  본문은 `content` 블록들의 `text` 를 이어 붙인다. 블록 유형이 방향에 따라 다르다 — 들어오는
 *  것은 `input_text`, 나가는 것은 `output_text` — 그래서 유형으로 고르지 않고 문자열 `text` 가
 *  있는 블록을 전부 받는다. */
function eventMessage(obj: Record<string, unknown>): { kind: 'user' | 'agent'; text: string } | null {
  if (obj.type !== 'response_item') return null
  const payload = obj.payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const p = payload as Record<string, unknown>
  if (p.type !== 'message') return null
  if (p.role !== 'user' && p.role !== 'assistant') return null
  const text = contentText(p.content)
  if (text === null) return null
  return { kind: p.role === 'user' ? 'user' : 'agent', text }
}

/** `response_item/message` 의 본문. 블록 배열에서 문자열 `text` 를 이어 붙인다. 빈 결과는 null —
 *  텍스트 없는 메시지(도구 호출만 실린 줄 등)를 대화로 세지 않는다. */
function contentText(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() === '' ? null : content
  if (!Array.isArray(content)) return null
  let out = ''
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const t = (block as { text?: unknown }).text
    if (typeof t === 'string') out += t
  }
  return out.trim() === '' ? null : out
}

// System wrappers codex records as user_message — excluded from the title and the preview (mirrors
// isRealUserText in parser.ts)
//
// **이 목록이 판정을 혼자 진다.** claude 쪽은 레코드에 `isMeta` 가 붙어 오므로 표지 없는 주입도
// 구조로 걸러 낼 수 있지만(parser.ts 의 isMetaUserRecord), codex rollout 레코드의 최상위 키는
// `payload`·`timestamp`·`type` 셋뿐이다(실측) — 구조로 물어볼 것이 없어서 접두어밖에 없다.
const CODEX_WRAPPER_PREFIXES = [
  '<environment_context>',
  '<user_instructions>',
  '<permissions',
  '<turn_aborted',
  // 아래는 **claude 를 코디네이터로 두고 codex 워커를 돌릴 때** rollout 에 그대로 실려 온 것들이다
  // (실측 2026-08-28, 이 컴퓨터의 실제 rollout 150개 / 통과 user_message 262건):
  '<task-notification>', // 26건, 파일 2개
  '<command-name>', // 6건, 파일 4개
  '<local-command-stdout>', // 4건, 파일 3개
  '[Request interrupted', // 2건, 파일 2개
  // 실측 0건이지만 위 셋의 짝이라 함께 넣는다 — parser.ts 의 MACHINE_USER_PREFIXES 가
  // `<bash-stderr>` 를 "모양으로 추가(위 짝)"한 것과 같은 이유다. 짝 하나만 걸러 두면 반쪽짜리
  // 기록이 사람의 요청으로 남는다.
  '<command-message>',
  '<command-args>',
  // codex 고유. 승인 흐름이 codex 에게 지난 기록을 다시 읽어 주는 문장이고, 길어서 통과분 글자의
  // 대부분을 차지했다(실측 — 2000자 초과 78건이 통과분 글자의 91.8%). 사람이 쓴 요청이 아니다.
  'The following is the Codex agent history',
  // `response_item` 을 읽기 시작하면서 드러난 것(실측 2026-08-29): 사용자 롤 첫 메시지가 프로젝트의
  // AGENTS.md 를 통째로 실은 10KB 짜리 주입이다. 사람이 쓴 요청이 아니고, 그대로 두면 히스토리
  // 제목이 그 문서의 첫 줄이 된다.
  '# AGENTS.md instructions'
]

function isRealCodexUserText(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return !CODEX_WRAPPER_PREFIXES.some((p) => t.startsWith(p))
}

function parseLine(raw: string): Record<string, unknown> | null {
  try {
    const obj: unknown = JSON.parse(raw)
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null
    return obj as Record<string, unknown>
  } catch {
    return null // defensive parsing — ignore a broken line
  }
}

/** Extracts session_meta (sessionId, cwd) and the first user title within the leading maxLines
 *  (mirrors parseTranscriptMeta in parser.ts) */
/** Was this rollout written by a one-shot `codex exec` run rather than a session someone opened?
 *
 *  Both callers of this — the rollout-to-session match (rolling/codexLocate.ts) and the history list
 *  — want the same answer, so the rule lives here once. Measured 2026-08-31: this app's explanation
 *  generator runs `codex exec` in the same account and the same project folder as the user's own
 *  session, and the match picks the newest file, so the generator's rollout was taking the user
 *  session's place. Everything read for that session afterwards — its work units, its usage chip, its
 *  limit detection — was then reading the wrong file. A work unit turned up titled with the first line
 *  of the explanation prompt.
 *
 *  Only an explicit "exec" counts. A file with no source (an older codex) is left alone: dropping a
 *  real session silently kills its tracking, which costs far more than an extra row. */
export function isExecRollout(meta: CodexMeta): boolean {
  return meta.source === 'exec'
}

export async function parseCodexMeta(filePath: string, maxLines = 40): Promise<CodexMeta> {
  const meta: CodexMeta = { sessionId: null, cwd: null, title: null, source: null }
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const rl = createInterface({ input: stream })
  let n = 0
  try {
    for await (const raw of rl) {
      if (++n > maxLines) break
      const obj = parseLine(raw)
      if (!obj) continue
      if (obj.type === 'session_meta') {
        const p = obj.payload
        if (p !== null && typeof p === 'object' && !Array.isArray(p)) {
          const pr = p as Record<string, unknown>
          if (meta.sessionId === null && typeof pr.session_id === 'string') meta.sessionId = pr.session_id
          if (meta.sessionId === null && typeof pr.id === 'string') meta.sessionId = pr.id
          if (meta.cwd === null && typeof pr.cwd === 'string') meta.cwd = pr.cwd
          if (meta.source === null && typeof pr.source === 'string') meta.source = pr.source
        }
        continue
      }
      if (meta.title === null) {
        const msg = eventMessage(obj)
        if (msg && msg.kind === 'user' && isRealCodexUserText(msg.text)) meta.title = toTitle(msg.text)
      }
      if (meta.sessionId && meta.cwd && meta.title) break
    }
  } finally {
    rl.close()
    stream.destroy()
  }
  return meta
}

/** Reads only the last tailBytes of the file for the last user title and whether a reply is unread
 *  (mirrors parseTranscriptTail in parser.ts) */
export async function parseCodexTail(
  filePath: string,
  tailBytes = 256 * 1024
): Promise<{ lastUserTitle: string | null; awaitingReply: boolean }> {
  const empty = { lastUserTitle: null, awaitingReply: false }
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(filePath, 'r')
    const stat = await handle.stat()
    const start = Math.max(0, stat.size - tailBytes)
    const length = stat.size - start
    if (length <= 0) return empty
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    let text = buffer.toString('utf8')
    if (start > 0) {
      // Reading started mid-file, so everything before the first newline (an incomplete line) is
      // discarded — a newline is 1 byte, so a multibyte boundary is safe too
      const nl = text.indexOf('\n')
      text = nl === -1 ? '' : text.slice(nl + 1)
    }
    const lines = text.split('\n').filter((l) => l.trim().length > 0)

    let lastUserTitle: string | null = null
    let awaitingReply = false
    let roleResolved = false

    for (let i = lines.length - 1; i >= 0; i--) {
      const obj = parseLine(lines[i])
      if (!obj) continue
      const msg = eventMessage(obj)
      if (!msg) continue

      if (!roleResolved) {
        if (msg.kind === 'agent') {
          awaitingReply = true
          roleResolved = true
        } else if (isRealCodexUserText(msg.text)) {
          awaitingReply = false
          roleResolved = true
        }
      }

      if (lastUserTitle === null && msg.kind === 'user' && isRealCodexUserText(msg.text))
        lastUserTitle = toTitle(msg.text)

      if (lastUserTitle !== null && roleResolved) break // early exit
    }

    return { lastUserTitle, awaitingReply }
  } catch {
    return empty
  } finally {
    // Honours the no-throw contract even if close itself rejects (a double close, for instance)
    try {
      await handle?.close()
    } catch {
      /* an fd cleanup failure is ignored — it does not affect the result */
    }
  }
}

/** 미리보기용 파싱 — parseTranscriptPreview(parser.ts)와 **같은 규칙이어야 한다.** 두 provider 의
 *  미리보기가 서로 다른 범위를 보여 주면 같은 화면이 계정에 따라 다르게 읽힌다. 그래서 턴을 자르는
 *  일은 lastTurns 하나가 하고 여기서 되풀이하지 않는다. */
export async function parseCodexPreview(
  filePath: string,
  maxTurns = PREVIEW_TURNS
): Promise<{ messages: TranscriptMessage[]; truncated: boolean }> {
  const messages: TranscriptMessage[] = []
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const rl = createInterface({ input: stream })
  try {
    for await (const raw of rl) {
      const obj = parseLine(raw)
      if (!obj) continue
      const msg = eventMessage(obj)
      if (!msg) continue
      if (msg.kind === 'user' && !isRealCodexUserText(msg.text)) continue
      messages.push({
        role: msg.kind === 'user' ? 'user' : 'assistant',
        text: msg.text,
        timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : undefined
      })
    }
  } finally {
    rl.close()
    stream.destroy()
  }
  return lastTurns(messages, maxTurns)
}

/** 탭 세션용 재개 브리핑의 재료 — parseTranscriptForResume(parser.ts)의 codex 대응.
 *
 *  **claude 와 같은 다섯 중 둘만 채운다.** codex rollout 에는 claude 의 `ai-title`/`summary`(대화
 *  제목 레코드)나 `file-history-snapshot`(손댄 파일 스냅숏)에 해당하는 레코드가 없다 — 있지도 않은
 *  것을 첫 사용자 메시지 등으로 대신 채우면 "어느 메시지가 작업인지 판정하지 않는다"는 계획의
 *  규칙을 이 provider 에서만 깨는 것이 된다. 그래서 `title` 은 항상 `null`, `editedFiles` 는 항상
 *  빈 배열이다 — 후자는 buildTabResumeText(main/orchestration/resumePacket.ts)가 이미 git 변경
 *  목록으로 내려가는 경로를 갖고 있어 손실이 없다. `lastCommand` 도 같은 이유로 항상 `null` 이다 —
 *  codex 의 실행 기록(`function_call`/`function_call_output`, 도구 이름 `exec_command`)은 claude 의
 *  `tool_use`(Bash)/`tool_result`(`is_error`) 와 필드 모양이 다르고 그쪽은 측정한 적이 없다. 있지도
 *  않은 모양을 추측해 채우는 것은 이 필드가 지키려는 것("모르는 것을 지어내지 않는다")과 정반대다.
 *  나머지 둘(`requests`·`tail`)은 claude 와 같은 재료(event_msg 의 user_message/agent_message)에서
 *  뽑는다 — parseCodexPreview 와 같은 판정(isRealCodexUserText)을 쓴다. */
export async function parseCodexForResume(filePath: string): Promise<TranscriptResumeMaterial> {
  const result: TranscriptResumeMaterial = {
    title: null,
    requests: [],
    editedFiles: [],
    tail: [],
    lastCommand: null
  }
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const rl = createInterface({ input: stream })
  try {
    for await (const raw of rl) {
      const obj = parseLine(raw)
      if (!obj) continue
      const msg = eventMessage(obj)
      if (!msg) continue
      if (msg.kind === 'user') {
        if (!isRealCodexUserText(msg.text)) continue // 기계가 남긴 wrapper — 요청도 꼬리도 아니다
        result.requests.push(msg.text)
        if (result.requests.length > READ_BUFFER_MAX) result.requests.shift()
      }
      result.tail.push({
        role: msg.kind === 'user' ? 'user' : 'assistant',
        text: msg.text,
        timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : undefined
      })
      if (result.tail.length > READ_BUFFER_MAX) result.tail.shift()
    }
  } finally {
    rl.close()
    stream.destroy()
  }
  return result
}

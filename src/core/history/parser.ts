import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { LastCommand, TranscriptMessage } from '../types'

export interface TranscriptMeta {
  sessionId: string | null
  cwd: string | null
  title: string | null
  rootUuid: string | null // uuid of the first type:'user' line — used to judge fork (resume) identity
  isSidechain: boolean // legacy sidechain — excluded from the index
  isHelper: boolean // non-conversation record file (first line queue-operation/ai-title/agent-name/bridge-session) — excluded from the index
}

export function extractText(message: unknown): string | null {
  const content = (message as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const block = content.find(
      (c): c is { type: string; text: string } =>
        typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'text' &&
        typeof (c as { text?: unknown }).text === 'string'
    )
    return block ? block.text : null
  }
  return null
}

export function toTitle(text: string): string | null {
  const t = text.trim().replace(/\s+/g, ' ')
  if (!t) return null
  return t.length > 80 ? t.slice(0, 80) + '…' : t
}

/** 사람이 쓰지 않은 `type: 'user'` 줄의 앞머리. 이 줄들도 트랜스크립트에서는 user 로 기록되므로,
 *  목록의 제목이 사람이 마지막에 친 말이 되려면 여기서 걸러야 한다.
 *
 *  **실측으로 모았다.** 이 저장소의 히스토리에서 목록에 실제로 나오는 파일 40 개를 재 보니
 *  bash-input 76 · bash-stdout 76 · task-notification 9 · local-command-caveat 5 ·
 *  command-name 5 · local-command-stdout 3 · `[Request interrupted` 14 ·
 *  `This session is being continued` 1 이었고, **그중 셋만 걸러지고 있었다.** 그래서 목록에
 *  `<task-notification> <task-id>…` 이나 `<bash-stdout>{"stopped":…}` 같은 것이 제목으로 떴다.
 *
 *  bash-stderr 와 system-reminder 는 이 표본에 없었지만 같은 부류의 기계 기록이고 사람이 그것으로
 *  메시지를 시작할 일이 없어 함께 넣는다 — 어느 것이 실측이고 어느 것이 모양으로 넣은 것인지
 *  구분해 두는 이유는, 근거 없이 얹은 항목이 나중에 반례를 만나는 것을 이 파일이 이미 겪었기
 *  때문이다(NON_CONVERSATION_FIRST_TYPES 의 ai-title).
 *
 *  전부 걸러져 남는 것이 없으면 호출하는 쪽이 첫 실제 사용자 메시지(meta.title)로 떨어진다
 *  (strategies/claude.ts) — 세션 uuid 를 제목으로 보여 주는 것보다 낫다. */
const MACHINE_USER_PREFIXES = [
  '<local-command-caveat>', // 실측
  '<local-command-stdout>', // 실측
  '<command-name>', // 실측
  '<bash-input>', // 실측 — 사용자가 `!` 로 실행한 명령. 행동이지만 할 말은 아니다
  '<bash-stdout>', // 실측
  '<bash-stderr>', // 모양으로 추가(위 짝)
  '<task-notification>', // 실측 — 배경 작업 완료 알림
  '<system-reminder>', // 모양으로 추가
  '[Request interrupted', // 실측
  'This session is being continued from a previous conversation' // 실측 — 압축 이어가기 안내
]

/** 사람이 실제로 쓴 텍스트인가 (제목과 대화 판정이 함께 쓴다) */
function isRealUserText(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return !MACHINE_USER_PREFIXES.some((p) => t.startsWith(p))
}

// Non-conversation record file: a session file holding only auxiliary records and no conversation
// messages. Identified by the first line's type and excluded from the index.
// queue-operation (HUD status line helper) · ai-title/agent-name (records of title and subagent name
// generation) · bridge-session (remote bridge marker).
// These have no cwd and no user/assistant messages, so if they show up in the list they are just
// folder-slug (D--…) noise.
const NON_CONVERSATION_FIRST_TYPES = new Set([
  'queue-operation',
  // **'ai-title' 은 여기 있었고, 실측이 빼게 했다.** 이 저장소의 히스토리 디렉터리를 전수 조사한
  // 결과: queue-operation 이 첫 줄인 파일 834 개(20KB~151KB, HUD 플러그인이 만든다), last-prompt
  // 37 개, mode 2 개, 그리고 **ai-title 은 딱 하나였는데 28.6MB 짜리 실제 대화**였다. 제목 기록은
  // 첫 사용자 줄보다 먼저 흘러나올 수 있고(그 하나가 그랬다), 그것을 헬퍼로 판정해 사람이 몇 시간
  // 쓴 세션을 목록에서 통째로 뺐다.
  //
  // 아래 둘은 같은 경합에 걸릴 수 있지만 반례를 아직 재지 못했다(이 디렉터리에 그것으로 시작하는
  // 파일이 0 개다). 반례가 나오면 같은 이유로 뺀다.
  'agent-name',
  'bridge-session'
])

/** Extracts the meta within the leading maxLines only — keeps even a huge transcript safe at the list stage */
export async function parseTranscriptMeta(filePath: string, maxLines = 50): Promise<TranscriptMeta> {
  const meta: TranscriptMeta = {
    sessionId: null,
    cwd: null,
    title: null,
    rootUuid: null,
    isSidechain: false,
    isHelper: false
  }
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const rl = createInterface({ input: stream })
  let n = 0
  let firstParsedLineSeen = false
  let firstUserLineSeen = false
  try {
    for await (const raw of rl) {
      if (++n > maxLines) break
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(raw)
      } catch {
        continue // defensive parsing — ignore a broken line
      }
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) continue
      // isHelper: decided from the first successfully parsed line only — the first line of an
      // interactive session is of the summary/user family, so it cannot be queue-operation (verified
      // by measurement). isSidechain: true if any line seen before the early exit carries the flag (a
      // sidechain file has the flag on every message line, so it is caught near the start).
      if (!firstParsedLineSeen) {
        firstParsedLineSeen = true
        meta.isHelper = typeof obj.type === 'string' && NON_CONVERSATION_FIRST_TYPES.has(obj.type)
      }
      if (obj.isSidechain === true) meta.isSidechain = true
      if (meta.sessionId === null && typeof obj.sessionId === 'string') meta.sessionId = obj.sessionId
      if (meta.cwd === null && typeof obj.cwd === 'string') meta.cwd = obj.cwd
      // rootUuid: taken from the first user line regardless of whether it is real (used to judge fork identity)
      if (!firstUserLineSeen && obj.type === 'user') {
        firstUserLineSeen = true
        if (typeof obj.uuid === 'string') meta.rootUuid = obj.uuid
      }
      if (meta.title === null && obj.type === 'user') {
        const text = extractText(obj.message)
        if (text && isRealUserText(text)) meta.title = toTitle(text)
      }
      if (meta.sessionId && meta.cwd && meta.title) break
    }
  } finally {
    rl.close()
    stream.destroy()
  }
  return meta
}

/** Reads only the last tailBytes of the file to pull out the last user message title and whether a
 *  reply is unread. It is called on every list refresh, so unlike the full parse
 *  (parseTranscriptPreview) it looks only near the end of the file. */
export async function parseTranscriptTail(
  filePath: string,
  tailBytes = 256 * 1024
): Promise<{ lastUserTitle: string | null; awaitingReply: boolean }> {
  const empty = { lastUserTitle: null, awaitingReply: false }
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(filePath, 'r')
    const stat = await handle.stat()
    const size = stat.size
    const start = Math.max(0, size - tailBytes)
    const length = size - start
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
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(lines[i])
      } catch {
        continue // defensive parsing — ignore a broken line
      }
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) continue

      if (!roleResolved) {
        if (obj.type === 'assistant') {
          if (extractText(obj.message) !== null) {
            awaitingReply = true
            roleResolved = true
          }
        } else if (obj.type === 'user') {
          const text2 = extractText(obj.message)
          if (text2 !== null && isRealUserText(text2)) {
            awaitingReply = false
            roleResolved = true
          }
        }
      }

      if (lastUserTitle === null && obj.type === 'user') {
        const text2 = extractText(obj.message)
        if (text2 !== null && isRealUserText(text2)) lastUserTitle = toTitle(text2)
      }

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

/** 탭 세션용 재개 브리핑의 재료. `buildTabResumeText`(main/orchestration/resumePacket.ts)가 대화
 *  파일 하나에서 이 넷을 **한 번의 읽기로** 뽑는다 — 따로따로 읽으면 같은(어쩌면 수십 MB짜리)
 *  파일을 네 번 훑는다. 무엇을 메모에 얼마나 실을지(개수·길이 상한)는 포매터
 *  (core/orchestration/tabResume.ts)가 정한다 — 이 함수는 재료만 모은다. */
export interface TranscriptResumeMaterial {
  /** `ai-title` 레코드의 `aiTitle`. 그 레코드가 없으면(구버전 claude, 또는 그 플러그인이 없는
   *  사용자) null — 대화 제목에 의존하지 않는다는 계약이 이 필드의 nullability 로 드러난다. */
  title: string | null
  /** 사람이 실제로 보낸 요청. 시간 순(오래된 것부터) — 셋 중 아무것도 "이것이 작업이다"로
   *  판정되지 않는다. */
  requests: string[]
  /** 가장 최근 `file-history-snapshot` 레코드의 `trackedFileBackups` 키. 이 맵은 누적이다(실측 —
   *  새 레코드가 이전 레코드의 키를 전부 포함한 채 자란다), 그래서 마지막 레코드 하나만 있으면
   *  충분하다. 그런 레코드가 한 번도 없으면 빈 배열 — 그때는 부르는 쪽이 git 변경 목록으로
   *  내려간다. */
  editedFiles: string[]
  /** 의미 있는 user/assistant 메시지의 꼬리. 사람이 안 쓴 `type:'user'` 줄(bash 출력 등)은
   *  parseTranscriptTail 과 같은 이유로 걸러진다 — §8.4 가 "tool raw output 대량 포함 금지"라고
   *  못박은 것이 바로 이 부류다. */
  tail: TranscriptMessage[]
  /** 대화 중 마지막으로 **완료된**(tool_result 가 실제로 도착한) Bash 호출. 아직 결과가 안 온
   *  채(세션이 그 도중에 끊긴 채) 대화가 끝나면 그 마지막 호출은 담기지 않는다 — 실패/성공 어느
   *  쪽도 참이 아직 아니고, 모르는 것을 지어내지 않는다. 한 번도 완료된 Bash 호출이 없으면 null.
   *  종료 코드는 기록되지 않는다(있는 것은 `tool_result.is_error` 불리언뿐) — `excerpt` 는 아직
   *  자르거나 가리지 않은 원문이고, 상한과 redaction 은 포매터(tabResume.ts)의 몫이다(다른 필드와
   *  같은 분업). */
  lastCommand: LastCommand | null
}

/** 읽는 동안 메모리에 들고 있을 요청·꼬리 각각의 상한. **최종적으로 몇 개를 메모에 싣는지는
 *  포매터가 정한다** — 이 상한은 그보다 넉넉한 여유일 뿐이고, 병적으로 긴 대화에서도 이 두 배열이
 *  무한히 자라지 않게 막는 것이 유일한 목적이다. codexParser.ts의 parseCodexForResume도 같은 상한을
 *  쓴다 — 그래서 export한다(claude와 codex 두 재료 읽기가 서로 다른 상한으로 갈리지 않게). */
export const READ_BUFFER_MAX = 20

/** `launchPrompt`(main/orchestration/coordinator.ts)가 spec 경로에 적용하는 것과 같은 정규화 —
 *  `file-history-snapshot`의 경로는 OS 그대로(윈도에서는 `\`)라서, 그 문자가 셸의 이스케이프
 *  문자로 읽히는 것을 앞서 그 파일이 겪은 것과 같은 이유로 미리 없앤다. */
function toPortablePath(p: string): string {
  return p.replace(/\\/g, '/')
}

/** `tool_result.content` 의 텍스트. 실측(2026-08-28, 이 컴퓨터의 실제 대화 파일 다수, Bash
 *  tool_result 12,816건)으로는 항상 문자열이었지만, extractText 가 message.content 에 대해 이미
 *  대비하는 것과 같은 배열 모양(text 블록)도 받아 둔다 — 다른 도구의 tool_result 가 이 모양으로
 *  오는 것은 이미 알려져 있고, 그 모양이 Bash 에도 언젠가 쓰이지 않을 이유가 없다. */
function extractToolResultText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const block = content.find(
      (c): c is { type: string; text: string } =>
        typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'text' &&
        typeof (c as { text?: unknown }).text === 'string'
    )
    return block ? block.text : null
  }
  return null
}

export async function parseTranscriptForResume(filePath: string): Promise<TranscriptResumeMaterial> {
  const result: TranscriptResumeMaterial = {
    title: null,
    requests: [],
    editedFiles: [],
    tail: [],
    lastCommand: null
  }
  // 아직 tool_result 를 못 받은, 가장 최근에 본 Bash tool_use — id 와 command 를 함께 들고 있다가
  // 짝이 되는 tool_result(같은 id) 를 만나면 result.lastCommand 로 확정한다. **결과가 도착한
  // 순서대로 확정하므로 "마지막" 은 결과가 가장 나중에 온 호출이다.**
  //
  // **한 슬롯이 아니라 맵인 이유(리뷰가 잡았다).** 한 턴이 Bash tool_use 를 여러 개 내보낼 수 있고
  // (독립적인 호출은 한 번에 묶어 보내는 것이 권장된다), 슬롯 하나면 나중 id 가 앞 id 를 덮어써서
  // **먼저 시작된 호출의 결과가 도착해도 짝을 못 찾고 조용히 버려졌다.** 맵이면 어느 순서로
  // 도착해도 짝이 맞는다. 미완으로 남는 항목은 파일을 다 읽고 그냥 버려진다 — 결과가 없는 호출은
  // 성공/실패를 말할 수 없으므로 이 절에 실을 것이 없다.
  const pendingBash = new Map<string, string>()
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const rl = createInterface({ input: stream })
  try {
    for await (const raw of rl) {
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(raw)
      } catch {
        continue // defensive parsing — ignore a broken line
      }
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) continue

      // 제목 레코드는 **이름이 버전마다 다르다** — 현행 Claude Code 는 `ai-title`(필드 `aiTitle`),
      // 구버전은 `summary`(필드 `summary`)로 남긴다. 이 앱은 구버전 CLI 를 쓰는 사용자에게도 나가므로
      // 둘 다 받는다. 한쪽만 받으면 그 사용자는 제목 줄을 영구히 못 받고, 그 사실이 조용히 지나간다.
      if (result.title === null && obj.type === 'ai-title' && typeof obj.aiTitle === 'string') {
        result.title = toTitle(obj.aiTitle)
        continue
      }
      if (result.title === null && obj.type === 'summary' && typeof obj.summary === 'string') {
        result.title = toTitle(obj.summary)
        continue
      }

      if (obj.type === 'file-history-snapshot') {
        const snapshot = obj.snapshot as { trackedFileBackups?: unknown } | undefined
        const tracked = snapshot?.trackedFileBackups
        if (tracked && typeof tracked === 'object' && !Array.isArray(tracked)) {
          result.editedFiles = Object.keys(tracked).map(toPortablePath)
        }
        continue
      }

      // Bash 호출과 그 결과 — extractText 가 text 블록만 찾는 것과 달리 여기서는 같은
      // message.content 배열에서 tool_use/tool_result 블록을 본다. 이 검사는 아래 text 추출과
      // 배타적이지 않다(같은 줄이 text 와 tool_use 를 함께 실을 수 있다) — 그래서 continue 하지
      // 않고 통과시킨다.
      const blocks = (obj.message as { content?: unknown } | undefined)?.content
      if (Array.isArray(blocks)) {
        for (const b of blocks) {
          if (b === null || typeof b !== 'object') continue
          const item = b as Record<string, unknown>
          if (obj.type === 'assistant' && item.type === 'tool_use' && item.name === 'Bash') {
            const input = item.input as { command?: unknown } | undefined
            if (typeof item.id === 'string' && typeof input?.command === 'string') {
              pendingBash.set(item.id, input.command)
            }
          } else if (
            obj.type === 'user' &&
            item.type === 'tool_result' &&
            typeof item.tool_use_id === 'string' &&
            pendingBash.has(item.tool_use_id)
          ) {
            result.lastCommand = {
              command: pendingBash.get(item.tool_use_id) as string,
              failed: item.is_error === true,
              excerpt: extractToolResultText(item.content) ?? ''
            }
            pendingBash.delete(item.tool_use_id) // 같은 id 의 결과가 두 번 오면 첫 번째만 센다
          }
        }
      }

      if (obj.type !== 'user' && obj.type !== 'assistant') continue
      const text = extractText(obj.message)
      if (text === null) continue

      if (obj.type === 'user') {
        if (!isRealUserText(text)) continue // 기계가 남긴 user 줄 — 요청도 꼬리도 아니다
        result.requests.push(text)
        if (result.requests.length > READ_BUFFER_MAX) result.requests.shift()
      }

      result.tail.push({
        role: obj.type,
        text,
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

/** Full (capped) parse for the preview — called only when an item is opened (lazy) */
/** 미리보기가 보여 주는 최근 턴 수. 한 턴은 user 메시지에서 시작해 다음 user 메시지 전까지다. */
export const PREVIEW_TURNS = 10

/** 마지막 `maxTurns` 턴만 남긴다. **앞이 아니라 뒤를 남기는 것이 요점이다** — 긴 세션의 첫 몇십
 *  메시지는 몇 시간 전 이야기이고, 미리보기가 답해야 하는 질문은 "이 세션에서 무엇을 하고
 *  있었나"다. 잘라 낸 것이 있으면 truncated 가 참이고, 화면의 문구가 최근 것만 보인다고 말한다.
 *
 *  턴의 시작을 user 메시지로 잡으므로, 남기는 첫 user 메시지보다 앞선 assistant 응답은 함께
 *  떨어진다 — 그것이 "턴"의 뜻이다. user 메시지가 아예 없는 기록은 그대로 다 남는다. */
export function lastTurns(
  messages: TranscriptMessage[],
  maxTurns: number
): { messages: TranscriptMessage[]; truncated: boolean } {
  const starts: number[] = []
  for (let i = 0; i < messages.length; i++) if (messages[i].role === 'user') starts.push(i)
  if (starts.length <= maxTurns) return { messages, truncated: false }
  return { messages: messages.slice(starts[starts.length - maxTurns]), truncated: true }
}

export async function parseTranscriptPreview(
  filePath: string,
  maxTurns = PREVIEW_TURNS
): Promise<{ messages: TranscriptMessage[]; truncated: boolean }> {
  const messages: TranscriptMessage[] = []
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const rl = createInterface({ input: stream })
  try {
    for await (const raw of rl) {
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(raw)
      } catch {
        continue
      }
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) continue
      if (obj.type !== 'user' && obj.type !== 'assistant') continue
      const text = extractText(obj.message)
      if (!text) continue
      messages.push({
        role: obj.type as 'user' | 'assistant',
        text,
        timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : undefined
      })
    }
  } finally {
    rl.close()
    stream.destroy()
  }
  // **파일을 끝까지 읽는다.** 마지막 턴들을 남기려면 끝을 봐야 하고, parseTranscriptTail 처럼
  // 바이트 꼬리만 읽으면 10 턴이 그 안에 들어오는지 알 수 없어 조용히 더 적게 보여 준다.
  // 값은 실측했다: 28MB·15,873 줄(user/assistant 5,270 개)을 162ms 에 읽는다. 이 함수는 사용자가
  // 미리보기를 열 때만 불린다 — 목록 갱신마다 불리는 parseTranscriptTail 과 다른 자리다.
  //
  // 대가는 잠깐 파일만큼의 문자열을 드는 것이다. 병목이 되면 여기서 롤링 버퍼로 바꾼다(턴 시작
  // 인덱스를 들고 앞에서 잘라 내면 메모리가 maxTurns 로 묶인다).
  return lastTurns(messages, maxTurns)
}

import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { LastCommand, TranscriptMessage } from '../types'
import {
  TRANSCRIPT_HEAD_BYTES,
  TRANSCRIPT_HEAD_BYTES_MAX,
  TRANSCRIPT_TAIL_BYTES,
  TRANSCRIPT_TAIL_BYTES_MAX,
  openTranscriptSource,
  parseTranscriptLine,
  readHeadLines,
  readTailLines,
  type TranscriptWindowOptions
} from './transcriptWindow'

export interface TranscriptMeta {
  sessionId: string | null
  cwd: string | null
  title: string | null
  rootUuid: string | null // uuid of the first type:'user' line — used to judge fork (resume) identity
  isSidechain: boolean // legacy sidechain — excluded from the index
  isHelper: boolean // non-conversation record file: a helper-typed first line (queue-operation/agent-name/bridge-session) AND no user/assistant/summary record in the head — excluded from the index and from transcript lookup
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
  '<command-message>', // 실측 — Claude Code 2.1.288 opens a slash command's line with this (titleOfUserText reads it)
  '<bash-input>', // 실측 — 사용자가 `!` 로 실행한 명령. 행동이지만 할 말은 아니다
  '<bash-stdout>', // 실측
  '<bash-stderr>', // 모양으로 추가(위 짝)
  '<task-notification>', // 실측 — 배경 작업 완료 알림
  '<system-reminder>', // 모양으로 추가
  '[Request interrupted', // 실측
  'This session is being continued from a previous conversation' // 실측 — 압축 이어가기 안내
]

/** 사람이 실제로 쓴 텍스트인가 (제목과 대화 판정이 함께 쓴다) */
export function isRealUserText(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return !MACHINE_USER_PREFIXES.some((p) => t.startsWith(p))
}

/** The list title a user line gives, or null when it gives none. A slash command run with arguments
 *  (`/astera-task <objective>`) is what the person typed, so it is titled as they typed it; one with no
 *  arguments (`/clear`) says nothing about the session and gives no title, as before. Any other line
 *  is titled by its text when it is the person's (isRealUserText). */
export function titleOfUserText(text: string): string | null {
  const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text)?.[1]
  if (name && /^\s*<command-(?:message|name)>/.test(text)) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim()
    return args ? toTitle(`${name} ${args}`) : null
  }
  return isRealUserText(text) ? toTitle(text) : null
}

/** CLI 가 스스로 끼워 넣은 `type:'user'` 레코드인가. **텍스트가 아니라 레코드를 본다** —
 *  MACHINE_USER_PREFIXES 는 `<bash-input>` 처럼 표지를 달고 오는 부류만 잡고, 스킬 본문은 표지
 *  없이 평범한 산문으로 시작해 그 목록을 그대로 통과한다.
 *
 *  **실측(2026-08-28, 이 컴퓨터의 최근 대화 파일 60개).** isRealUserText 를 통과한 user 텍스트
 *  268건 중 48건(17.9%)이 `isMeta:true` 였고, **글자 수로는 86.3%** 였다(스킬 본문이 통째로
 *  실린다). 60개 중 10개 파일에서 나왔고, 잡힌 것은 스킬 본문과 이미지 자리표시자
 *  (`[Image: original 3840x2088…]`)다. 재개 브리핑의 요청 절이 이것들로 채워지면 예산
 *  (tabResume.ts 의 MEMO_CHARS_MAX)을 사람이 쓴 요청이 아닌 것에 내주고, 히스토리 목록의 제목이
 *  스킬 본문이 되고, 답변 대기 표시(초록 점)가 사람이 말한 적 없는 줄 때문에 꺼진다.
 *
 *  `turnCompanion`·`sourceToolUseID` 도 같은 레코드에 함께 오지만(실측) 이 판정은 `isMeta` 하나만
 *  본다 — 셋 중 그 하나가 "사람이 쓴 것이 아니다"를 직접 뜻하고, 나머지 둘은 그 레코드가 어디서
 *  왔는지를 말할 뿐이다. */
export function isMetaUserRecord(obj: Record<string, unknown>): boolean {
  return obj.isMeta === true
}

// Non-conversation record file: a session file holding only auxiliary records and no conversation
// messages. A candidate is recognised by its first line's type, and **confirmed** by the head of the
// file (the first maxLines) carrying no user/assistant/summary record at all — the first line alone is
// not enough, see the queue-operation note below. Excluded from the index and from transcript lookup.
// queue-operation (HUD status line helper) · agent-name (subagent name record) · bridge-session (remote
// bridge marker). True helper files have no cwd and no user/assistant messages, so if they show up in
// the list they are just folder-slug (D--…) noise.
const NON_CONVERSATION_FIRST_TYPES = new Set([
  // **A first line of queue-operation no longer decides on its own.** Measured 2026-09-17 across this
  // machine's ~/.claude/projects: 1343 files start with queue-operation AND hold a real conversation
  // within 50 lines, and 0 start with it and hold none. A stream-json user message that is queued
  // before the CLI takes it writes queue-operation as the file's first records — a chat session's
  // scheduled command did exactly that, and the whole session vanished from the history list and from
  // its own pane (transcriptPathById → buildEntry → isHelper). Same false positive ai-title had.
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
  // isHelper is a verdict about the whole head, not the first line: a helper-typed first line makes
  // the file a candidate, and a conversation record anywhere in the head clears it. Decided after the
  // loop, whichever way the loop ended (maxLines, EOF, or the early exit once sessionId/cwd/title are
  // known — that exit is only reachable after a user record, which is itself a conversation record).
  let helperCandidate = false
  let sawConversationRecord = false
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
      // isSidechain: true if any line seen before the early exit carries the flag (a sidechain file has
      // the flag on every message line, so it is caught near the start).
      if (!firstParsedLineSeen) {
        firstParsedLineSeen = true
        helperCandidate = typeof obj.type === 'string' && NON_CONVERSATION_FIRST_TYPES.has(obj.type)
      }
      if (obj.type === 'user' || obj.type === 'assistant' || obj.type === 'summary')
        sawConversationRecord = true
      if (obj.isSidechain === true) meta.isSidechain = true
      if (meta.sessionId === null && typeof obj.sessionId === 'string') meta.sessionId = obj.sessionId
      if (meta.cwd === null && typeof obj.cwd === 'string') meta.cwd = obj.cwd
      // rootUuid: taken from the first user line regardless of whether it is real (used to judge fork identity)
      if (!firstUserLineSeen && obj.type === 'user') {
        firstUserLineSeen = true
        if (typeof obj.uuid === 'string') meta.rootUuid = obj.uuid
      }
      if (meta.title === null && obj.type === 'user' && !isMetaUserRecord(obj)) {
        const text = extractText(obj.message)
        if (text) meta.title = titleOfUserText(text)
      }
      if (meta.sessionId && meta.cwd && meta.title) break
    }
  } finally {
    rl.close()
    stream.destroy()
  }
  meta.isHelper = helperCandidate && !sawConversationRecord
  return meta
}

/** Reads only the last tailBytes of the file to pull out the last user message title and whether a
 *  reply is unread. It is called on every list refresh, so it reads one fixed window and never widens
 *  it, unlike the preview (parseTranscriptPreview), which widens until it has enough turns. */
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
        } else if (obj.type === 'user' && !isMetaUserRecord(obj)) {
          const text2 = extractText(obj.message)
          if (text2 !== null && isRealUserText(text2)) {
            awaitingReply = false
            roleResolved = true
          }
        }
      }

      if (lastUserTitle === null && obj.type === 'user' && !isMetaUserRecord(obj)) {
        const text2 = extractText(obj.message)
        if (text2 !== null) lastUserTitle = titleOfUserText(text2)
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

/** 탭 세션용 재개 브리핑의 재료. `buildTabResumeText`(core/orchestration/exec/resumePacket.ts)가 대화
 *  파일 하나에서 이 넷을 **한 번의 읽기로** 뽑는다 — 따로따로 읽으면 같은(어쩌면 수십 MB짜리)
 *  파일을 네 번 훑는다. 무엇을 메모에 얼마나 실을지(개수·길이 상한)는 포매터
 *  (core/orchestration/tabResume.ts)가 정한다 — 이 함수는 재료만 모은다. */
export interface TranscriptResumeMaterial {
  /** 제목 레코드의 값 — 현행 claude 가 남기는 `ai-title`(필드 `aiTitle`)이나 구버전이 남기는
   *  `summary`(필드 `summary`) 중 먼저 만난 쪽(아래 parseTranscriptForResume 의 판정문이 둘 다
   *  받는 이유를 적어 둔다). **둘 다 claude 자신이 남기는 기록이다** — 플러그인이 남기는 것이
   *  아니라, 있다면 그저 이 레코드를 읽을 뿐이다. 어느 쪽도 없으면(구버전 claude 이거나, 그
   *  레코드가 쓰이기 전에 대화 파일을 읽었거나) null — 대화 제목에 의존하지 않는다는 계약이 이
   *  필드의 nullability 로 드러난다. */
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

/** `launchPrompt`(core/orchestration/exec/coordinator.ts)가 spec 경로에 적용하는 것과 같은 정규화 —
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

/** 재개 재료에 쓰이는 한 줄의 요약. 창(window)을 뒤에서부터 넓혀 가며 읽으므로 줄을 읽는 순서가
 *  파일 순서가 아니다 — 그래서 줄마다 필요한 것만 이 모양으로 뽑아 두고(파싱은 줄마다 한 번), 창이
 *  넓어질 때마다 파일 순서로 이어 붙인 목록을 foldResume 이 처음부터 다시 접는다. 접기는 문자열을
 *  옮길 뿐이라 싸다. 이 분리 덕에 판정 규칙은 foldResume 한 곳에만 있고, 그것은 창 이전의
 *  전체 읽기(fixtures/parserReference.ts)의 루프 본문과 한 줄씩 대응한다. */
type ResumeLine =
  | { kind: 'title'; value: string }
  | { kind: 'snapshot'; files: string[] }
  | {
      kind: 'message'
      role: 'user' | 'assistant'
      bashUses: Array<{ id: string; command: string }>
      /** 이 줄의 tool_use id 전부(Bash 가 아닌 것도) — 창이 어떤 결과의 호출까지 담았는지 알려고 든다 */
      toolUseIds: string[]
      toolResults: Array<{ id: string; failed: boolean; excerpt: string }>
      text: string | null
      isMeta: boolean
      timestamp: string | undefined
    }

function resumeLineOf(obj: Record<string, unknown>): ResumeLine | null {
  // 제목 레코드는 **이름이 버전마다 다르다** — 현행 Claude Code 는 `ai-title`(필드 `aiTitle`),
  // 구버전은 `summary`(필드 `summary`)로 남긴다. 이 앱은 구버전 CLI 를 쓰는 사용자에게도 나가므로
  // 둘 다 받는다. 한쪽만 받으면 그 사용자는 제목 줄을 영구히 못 받고, 그 사실이 조용히 지나간다.
  if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') return { kind: 'title', value: obj.aiTitle }
  if (obj.type === 'summary' && typeof obj.summary === 'string') return { kind: 'title', value: obj.summary }

  if (obj.type === 'file-history-snapshot') {
    const snapshot = obj.snapshot as { trackedFileBackups?: unknown } | undefined
    const tracked = snapshot?.trackedFileBackups
    if (tracked && typeof tracked === 'object' && !Array.isArray(tracked)) {
      return { kind: 'snapshot', files: Object.keys(tracked).map(toPortablePath) }
    }
    return null
  }

  // 아래의 어느 판정도 user/assistant 가 아닌 줄에는 효과가 없다(Bash 짝은 assistant 의 tool_use 와
  // user 의 tool_result 뿐이고, 텍스트는 두 역할만 싣는다).
  if (obj.type !== 'user' && obj.type !== 'assistant') return null
  const line: ResumeLine = {
    kind: 'message',
    role: obj.type,
    bashUses: [],
    toolUseIds: [],
    toolResults: [],
    text: extractText(obj.message),
    isMeta: isMetaUserRecord(obj),
    timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : undefined
  }
  // Bash 호출과 그 결과 — extractText 가 text 블록만 찾는 것과 달리 여기서는 같은
  // message.content 배열에서 tool_use/tool_result 블록을 본다. 같은 줄이 text 와 tool_use 를 함께
  // 실을 수 있으므로 둘 다 담는다.
  const blocks = (obj.message as { content?: unknown } | undefined)?.content
  if (Array.isArray(blocks)) {
    for (const b of blocks) {
      if (b === null || typeof b !== 'object') continue
      const item = b as Record<string, unknown>
      if (obj.type === 'assistant' && item.type === 'tool_use' && typeof item.id === 'string') line.toolUseIds.push(item.id)
      if (obj.type === 'assistant' && item.type === 'tool_use' && item.name === 'Bash') {
        const input = item.input as { command?: unknown } | undefined
        if (typeof item.id === 'string' && typeof input?.command === 'string') {
          line.bashUses.push({ id: item.id, command: input.command })
        }
      } else if (obj.type === 'user' && item.type === 'tool_result' && typeof item.tool_use_id === 'string') {
        line.toolResults.push({
          id: item.tool_use_id,
          failed: item.is_error === true,
          excerpt: extractToolResultText(item.content) ?? ''
        })
      }
    }
  }
  return line
}

/** 파일 순서의 줄 요약들을 재개 재료로 접는다. */
function foldResume(lines: readonly ResumeLine[]): TranscriptResumeMaterial {
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
  // 도착해도 짝이 맞는다. 미완으로 남는 항목은 다 접고 그냥 버려진다 — 결과가 없는 호출은
  // 성공/실패를 말할 수 없으므로 이 절에 실을 것이 없다.
  const pendingBash = new Map<string, string>()
  for (const line of lines) {
    if (line.kind === 'title') {
      if (result.title === null) result.title = toTitle(line.value)
      continue
    }
    if (line.kind === 'snapshot') {
      result.editedFiles = line.files
      continue
    }
    for (const use of line.bashUses) pendingBash.set(use.id, use.command)
    for (const r of line.toolResults) {
      if (!pendingBash.has(r.id)) continue
      result.lastCommand = { command: pendingBash.get(r.id) as string, failed: r.failed, excerpt: r.excerpt }
      pendingBash.delete(r.id) // 같은 id 의 결과가 두 번 오면 첫 번째만 센다
    }

    const text = line.text
    if (text === null) continue
    if (line.role === 'user') {
      // 기계가 남긴 user 줄 — 요청도 꼬리도 아니다. 표지를 단 부류(접두어)와 표지 없이 오는
      // 부류(isMeta, 스킬 본문 등) 둘 다 여기서 떨어진다.
      if (!isRealUserText(text) || line.isMeta) continue
      result.requests.push(text)
      if (result.requests.length > READ_BUFFER_MAX) result.requests.shift()
    }
    result.tail.push({ role: line.role, text, timestamp: line.timestamp })
    if (result.tail.length > READ_BUFFER_MAX) result.tail.shift()
  }
  return result
}

/** 창이 이만큼을 담았으면 더 넓혀도 재료가 바뀌지 않는다:
 *  - 요청과 꼬리가 둘 다 상한(READ_BUFFER_MAX)까지 찼다 — 그 앞의 것은 어차피 밀려난다.
 *  - 손댄 파일 목록의 출처인 가장 최근 snapshot 이 창 안에 있다.
 *  - 완료된 Bash 호출(짝)이 창 안에 있고, **그 뒤의 어떤 tool_result 도 호출이 창 밖에 있지 않다.**
 *    창 밖에서 시작한 Bash 가 그 뒤에 끝났다면 전체 읽기의 lastCommand 는 그것이다 — 결과가 어느
 *    도구의 것인지는 호출을 봐야 알 수 있으므로, 호출이 창 밖인 결과가 하나라도 남아 있으면 넓힌다.
 *    호출은 보통 결과 바로 앞에 있어 한 번 넓히면 풀린다.
 *  셋 중 무엇이든 끝내 안 차는 파일(Bash 를 한 번도 안 쓴 세션 등)은 상한까지 읽는다 — 그 비용은
 *  상한이 묶고, 비동기다. */
function resumeWindowIsEnough(lines: readonly ResumeLine[]): boolean {
  let requests = 0
  let tail = 0
  let snapshot = false
  const uses = new Set<string>()
  const pendingBash = new Set<string>()
  let paired = false
  let orphanAfterPair = false
  for (const line of lines) {
    if (line.kind === 'snapshot') snapshot = true
    if (line.kind !== 'message') continue
    for (const id of line.toolUseIds) uses.add(id)
    for (const use of line.bashUses) pendingBash.add(use.id)
    for (const r of line.toolResults) {
      if (pendingBash.delete(r.id)) {
        paired = true
        orphanAfterPair = false
      } else if (!uses.has(r.id)) {
        orphanAfterPair = true
      }
    }
    if (line.text === null) continue
    if (line.role === 'user' && (!isRealUserText(line.text) || line.isMeta)) continue
    tail++
    if (line.role === 'user') requests++
  }
  return snapshot && paired && !orphanAfterPair && requests >= READ_BUFFER_MAX && tail >= READ_BUFFER_MAX
}

function resumeLinesOf(raw: readonly string[]): ResumeLine[] {
  const out: ResumeLine[] = []
  for (const r of raw) {
    const obj = parseTranscriptLine(r)
    if (obj === null) continue
    const line = resumeLineOf(obj)
    if (line !== null) out.push(line)
  }
  return out
}

/** 대화 파일에서 재개 브리핑의 재료를 뽑는다.
 *
 *  **파일 전체가 아니라 창을 읽는다.** 이 함수는 Smart Resume 이 세션을 띄우기 전에 메인 스레드에서
 *  불린다(main/ipc.ts). 이 컴퓨터의 대화 파일은 100~143MB 에 이르고, 한 줄이 1MB 를 넘는다(base64
 *  이미지). 전부 JSON.parse 하던 동안 앱이 멈췄다. 이제는 꼬리 창(TRANSCRIPT_TAIL_BYTES)부터 읽고
 *  재료가 다 찰 때까지(resumeWindowIsEnough) 두 배씩 넓히되 TRANSCRIPT_TAIL_BYTES_MAX 에서 멈춘다.
 *  무거운 줄은 parseTranscriptLine 이 base64 를 비우고 파싱한다.
 *
 *  제목만은 파일의 **첫** 제목 레코드여야 하고 그것은 앞머리에 있다(TRANSCRIPT_HEAD_BYTES 의 실측).
 *  꼬리 창이 파일 처음까지 닿지 않았으면 작은 머리 창(TRANSCRIPT_HEAD_BYTES → _MAX)을 따로 읽어
 *  찾는다. 머리 창에서 못 찾으면 꼬리 창에서 처음 만난 제목을 쓴다 — 머리 창이 꼬리 창에 닿았다면
 *  그것이 곧 첫 제목이다.
 *
 *  **결과는 전체 읽기와 같다. 다를 수 있는 경우는 정확히 이것뿐이다:**
 *  1. 꼬리 창이 상한(TRANSCRIPT_TAIL_BYTES_MAX)에 닿고도 재료가 안 찼을 때 — 요청·꼬리가 덜 찬
 *     채로, 손댄 파일이 창 안의 마지막 snapshot 에서(없으면 빈 채로), lastCommand 가 창 안에서
 *     짝지은 마지막 호출(없으면 null)로 돌아온다.
 *  2. 머리 창이 상한(TRANSCRIPT_HEAD_BYTES_MAX)에 닿고도 제목을 못 찾았고 꼬리 창에도 닿지 않았을 때 —
 *     제목이 꼬리 창의 첫 제목(없으면 null)이 된다.
 *  3. 줄 하나가 HEAVY_LINE_CHARS 를 넘을 때 — 값 전체가 4096 자 이상의 base64 인 JSON 문자열은
 *     빈 문자열로 읽힌다(transcriptWindow.ts 의 parseTranscriptLine). 사람이 그런 토큰 하나만을
 *     메시지로 보냈다면 그 요청은 빠진다. 글 사이에 낀 토큰은 그대로다.
 *  4. 그러고도 줄 하나가 PARSE_LINE_CHARS_MAX 를 넘을 때 — 그 줄은 파싱하지 않고 건너뛴다.
 *  1·2 는 창 크기의 문제라 상한을 넘는 파일에서만, 3·4 는 창과 무관하게 그런 줄이 있을 때만
 *  생긴다. 이 넷은 parserWindow.test.ts 가 하나씩 보여 준다. */
export async function parseTranscriptForResume(
  filePath: string,
  opts?: TranscriptWindowOptions
): Promise<TranscriptResumeMaterial> {
  const src = await (opts?.open ?? openTranscriptSource)(filePath)
  try {
    let lines: ResumeLine[] = []
    const { from } = await readTailLines(
      src,
      { initial: opts?.tailBytes ?? TRANSCRIPT_TAIL_BYTES, max: opts?.maxTailBytes ?? TRANSCRIPT_TAIL_BYTES_MAX },
      (raw) => {
        lines = resumeLinesOf(raw).concat(lines)
        return resumeWindowIsEnough(lines)
      }
    )
    const result = foldResume(lines)
    if (from > 0) {
      let headTitle: string | null = null
      await readHeadLines(
        src,
        from,
        { initial: opts?.headBytes ?? TRANSCRIPT_HEAD_BYTES, max: opts?.maxHeadBytes ?? TRANSCRIPT_HEAD_BYTES_MAX },
        (raw) => {
          for (const r of raw) {
            // 제목 레코드의 type 값은 JSON 에 그대로 적힌다 — 이 글자가 없는 줄은 파싱할 필요가 없다.
            if (!r.includes('"ai-title"') && !r.includes('"summary"')) continue
            const obj = parseTranscriptLine(r)
            const line = obj === null ? null : resumeLineOf(obj)
            // 공백뿐인 제목은 없는 것으로 친다 — foldResume 이 다음 제목 레코드로 넘어가는 것과 같다.
            const title = line?.kind === 'title' ? toTitle(line.value) : null
            if (title !== null) {
              headTitle = title
              return true
            }
          }
          return false
        }
      )
      if (headTitle !== null) result.title = headTitle
    }
    return result
  } finally {
    await src.close().catch(() => undefined)
  }
}

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

function previewMessagesOf(raw: readonly string[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  for (const r of raw) {
    const obj = parseTranscriptLine(r)
    if (obj === null) continue
    if (obj.type !== 'user' && obj.type !== 'assistant') continue
    const text = extractText(obj.message)
    if (!text) continue
    out.push({
      role: obj.type as 'user' | 'assistant',
      text,
      timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : undefined
    })
  }
  return out
}

function userCount(messages: readonly TranscriptMessage[]): number {
  let n = 0
  for (const m of messages) if (m.role === 'user') n++
  return n
}

/** 미리보기 — 사용자가 목록의 항목을 열 때만 불린다.
 *
 *  **파일 전체가 아니라 꼬리 창을 읽는다.** 예전에는 끝까지 스트림으로 읽었다(28MB 를 162ms 에
 *  읽는다는 실측이 근거였다). 이 컴퓨터의 대화 파일이 100~143MB 로 자라고 1MB 가 넘는 이미지 줄을
 *  싣게 되면서 그 근거가 무너졌다. 이제 창을 두 배씩 넓혀 **user 메시지가 maxTurns + 1 개** 모일
 *  때까지만 읽는다 — 그만큼 모이면 마지막 maxTurns 턴이 창 안에 온전히 있고, 잘린 것이 있다는
 *  것(truncated)도 확실하다. 그러면 결과가 전체 읽기와 같다. 파일 처음에 닿아도 같다.
 *
 *  상한(TRANSCRIPT_TAIL_BYTES_MAX)에서 멈춘 경우만 추정이다: 창 앞에 무엇이 더 있으므로 truncated 는
 *  참이다. 창 안에 user 메시지가 maxTurns 개 있으면 첫 user 메시지 앞의 assistant 응답은 창 밖의
 *  (보여 주지 않을) 턴에 속하므로 떨어뜨리고, 그보다 적으면 그 응답이 속한 턴도 보여 줄 턴이므로
 *  보이는 만큼 남긴다. 줄 하나가 너무 길 때의 차이(parseTranscriptForResume 문서의 3·4)는 여기서도
 *  같다. */
export async function parseTranscriptPreview(
  filePath: string,
  maxTurns = PREVIEW_TURNS,
  opts?: TranscriptWindowOptions
): Promise<{ messages: TranscriptMessage[]; truncated: boolean }> {
  const src = await (opts?.open ?? openTranscriptSource)(filePath)
  let messages: TranscriptMessage[] = []
  let from: number
  try {
    ;({ from } = await readTailLines(
      src,
      { initial: opts?.tailBytes ?? TRANSCRIPT_TAIL_BYTES, max: opts?.maxTailBytes ?? TRANSCRIPT_TAIL_BYTES_MAX },
      (raw) => {
        messages = previewMessagesOf(raw).concat(messages)
        return userCount(messages) > maxTurns
      }
    ))
  } finally {
    await src.close().catch(() => undefined)
  }
  if (from === 0 || userCount(messages) > maxTurns) return lastTurns(messages, maxTurns)
  if (userCount(messages) === maxTurns) {
    const first = messages.findIndex((m) => m.role === 'user')
    return { messages: first === -1 ? [] : messages.slice(first), truncated: true }
  }
  return { messages, truncated: true }
}

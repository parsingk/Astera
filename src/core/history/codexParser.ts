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
}

// Extracts only the conversation message from one event_msg line. null if it is not one (defensive parsing).
function eventMessage(obj: Record<string, unknown>): { kind: 'user' | 'agent'; text: string } | null {
  if (obj.type !== 'event_msg') return null
  const payload = obj.payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const p = payload as Record<string, unknown>
  if (p.type !== 'user_message' && p.type !== 'agent_message') return null
  if (typeof p.message !== 'string') return null
  return { kind: p.type === 'user_message' ? 'user' : 'agent', text: p.message }
}

// System wrappers codex records as user_message — excluded from the title and the preview (mirrors
// isRealUserText in parser.ts)
const CODEX_WRAPPER_PREFIXES = [
  '<environment_context>',
  '<user_instructions>',
  '<permissions',
  '<turn_aborted'
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
export async function parseCodexMeta(filePath: string, maxLines = 40): Promise<CodexMeta> {
  const meta: CodexMeta = { sessionId: null, cwd: null, title: null }
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
 *  **claude 와 같은 넷 중 둘만 채운다.** codex rollout 에는 claude 의 `ai-title`/`summary`(대화
 *  제목 레코드)나 `file-history-snapshot`(손댄 파일 스냅숏)에 해당하는 레코드가 없다 — 있지도 않은
 *  것을 첫 사용자 메시지 등으로 대신 채우면 "어느 메시지가 작업인지 판정하지 않는다"는 계획의
 *  규칙을 이 provider 에서만 깨는 것이 된다. 그래서 `title` 은 항상 `null`, `editedFiles` 는 항상
 *  빈 배열이다 — 후자는 buildTabResumeText(main/orchestration/resumePacket.ts)가 이미 git 변경
 *  목록으로 내려가는 경로를 갖고 있어 손실이 없다. 나머지 둘(`requests`·`tail`)은 claude 와 같은
 *  재료(event_msg 의 user_message/agent_message)에서 뽑는다 — parseCodexPreview 와 같은 판정
 *  (isRealCodexUserText)을 쓴다. */
export async function parseCodexForResume(filePath: string): Promise<TranscriptResumeMaterial> {
  const result: TranscriptResumeMaterial = { title: null, requests: [], editedFiles: [], tail: [] }
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

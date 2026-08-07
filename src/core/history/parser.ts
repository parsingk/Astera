import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { TranscriptMessage } from '../types'

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

/** Filters out text "the real user did not write" — command execution records, interruption markers,
 *  and the like (shared by the title and conversation decisions) */
function isRealUserText(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (t.startsWith('<local-command-caveat>')) return false // local command record wrapper
  if (t.startsWith('<command-name>')) return false // command execution record
  if (t.startsWith('[Request interrupted')) return false // interruption marker
  return true
}

// Non-conversation record file: a session file holding only auxiliary records and no conversation
// messages. Identified by the first line's type and excluded from the index.
// queue-operation (HUD status line helper) · ai-title/agent-name (records of title and subagent name
// generation) · bridge-session (remote bridge marker).
// These have no cwd and no user/assistant messages, so if they show up in the list they are just
// folder-slug (D--…) noise.
const NON_CONVERSATION_FIRST_TYPES = new Set([
  'queue-operation',
  'ai-title',
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

/** Full (capped) parse for the preview — called only when an item is opened (lazy) */
export async function parseTranscriptPreview(
  filePath: string,
  maxMessages = 200
): Promise<{ messages: TranscriptMessage[]; truncated: boolean }> {
  const messages: TranscriptMessage[] = []
  let truncated = false
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const rl = createInterface({ input: stream })
  try {
    for await (const raw of rl) {
      if (messages.length >= maxMessages) {
        truncated = true
        break
      }
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
  return { messages, truncated }
}

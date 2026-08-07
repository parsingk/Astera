import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import type { TranscriptMessage } from '../types'
import { toTitle } from './parser'

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

/** Full (capped) parse for the preview (mirrors parseTranscriptPreview in parser.ts) */
export async function parseCodexPreview(
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
  return { messages, truncated }
}

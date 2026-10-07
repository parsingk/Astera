// Where a Claude conversation went after it was sent to the background.
//
// Claude Code's background mode (`/background`, `--bg`) does not move a conversation, it copies it:
// the CLI forks it under a new session id, runs the copy in its own daemon, and closes the original
// with one record, `{"type":"continued-in","continuedInSessionId":"<new id>"}`. Everything said after
// that lives in the copy. Resuming the original id — which is what this app's tab and history entry
// still name — opens the conversation as it stood the moment it moved, without a word about it.
// Measured 2026-10-07 on Claude Code 2.1.291/2.1.292.
import { access, readdir } from 'node:fs/promises'
import path from 'node:path'
import { openTranscriptSource, parseTranscriptLine, readTailLines } from './transcriptWindow'

/** The record is the original's last line when it is written; anything behind it is a resume of the
 *  old id appending to it. 1 MB covers that with room to spare, and 16 MB bounds what a long talk in
 *  the old copy (which ends the search anyway, at its first prompt) can cost. */
const TAIL_BYTES = 1024 * 1024
const TAIL_BYTES_MAX = 16 * 1024 * 1024

/** A copy of a copy is followed too; this only bounds a chain that is somehow endless. */
const MAX_HOPS = 8

/** A prompt the person typed, as opposed to a tool result, a slash command's meta line, or the
 *  synthetic lines a resume writes. Once one sits behind the record, the old copy is a conversation
 *  someone chose to continue, and it is not ours to redirect. */
function isPersonPrompt(o: Record<string, unknown>): boolean {
  if (o.type !== 'user' || o.isMeta === true) return false
  const message = o.message as { content?: unknown } | undefined
  const content = message?.content
  if (typeof content === 'string') return true
  return Array.isArray(content) && content.some((b) => (b as { type?: unknown })?.type === 'text')
}

/** The id this transcript says it continued in, or null when it never moved or was talked to since. */
async function continuationOf(transcriptPath: string, sessionId: string): Promise<string | null> {
  let src
  try {
    src = await openTranscriptSource(transcriptPath)
  } catch {
    return null
  }
  let found: string | null = null
  try {
    await readTailLines(src, { initial: TAIL_BYTES, max: TAIL_BYTES_MAX }, (lines) => {
      for (let i = lines.length - 1; i >= 0; i--) {
        const o = parseTranscriptLine(lines[i])
        if (!o) continue
        if (isPersonPrompt(o)) return true
        if (o.type === 'continued-in' && o.sessionId === sessionId && typeof o.continuedInSessionId === 'string') {
          found = o.continuedInSessionId
          return true
        }
      }
      return false
    })
  } finally {
    await src.close().catch(() => undefined)
  }
  return found
}

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false
  )

/** The copy's transcript: beside the original first, then in the account's other project folders,
 *  since the copy is filed under the folder its daemon runs in. */
async function locate(transcriptPath: string, sessionId: string): Promise<string | null> {
  const name = `${sessionId}.jsonl`
  const beside = path.join(path.dirname(transcriptPath), name)
  if (await exists(beside)) return beside
  const projects = path.dirname(path.dirname(transcriptPath))
  let dirs: string[]
  try {
    dirs = await readdir(projects)
  } catch {
    return null
  }
  for (const d of dirs) {
    const candidate = path.join(projects, d, name)
    if (await exists(candidate)) return candidate
  }
  return null
}

/**
 * The conversation a resume of `sessionId` should open: the same one, or the copy it continued in
 * (following copies of copies). Never throws — anything it cannot read leaves the resume as asked.
 *
 * `unfiled` is a copy the record names whose transcript does not exist. Claude writes it only once
 * something is said in the copy, so `/background` on an idle conversation leaves exactly this
 * (measured 2026-10-07). The original still holds everything said, so it is what opens, but the copy
 * may be running in the background, and the caller has to ask.
 */
export async function followContinuedIn(a: {
  sessionId: string
  transcriptPath: string
}): Promise<{ sessionId: string; transcriptPath: string; unfiled?: string }> {
  let current = a
  const seen = new Set([a.sessionId])
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const next = await continuationOf(current.transcriptPath, current.sessionId)
    if (next === null || seen.has(next)) break
    const file = await locate(current.transcriptPath, next)
    if (file === null) return { ...current, unfiled: next }
    seen.add(next)
    current = { sessionId: next, transcriptPath: file }
  }
  return current
}

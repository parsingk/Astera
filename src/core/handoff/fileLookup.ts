// The Host's handoff lookup (Host journal P12): a synchronous read of the app's handoff.json, for the
// checkpoint's `handoffRef`. Answers as HandoffStore.lookup does: a missing file is `none` (known
// empty), a file it cannot read or does not recognise is `unknown`, never "none was left".
import { readFileSync } from 'node:fs'
import type { Handoff, HandoffLookup } from './types'
import { cachedByStampSync } from '../stampCache'

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

type Read = { state: 'none' | 'unknown' } | { memos: Record<string, unknown> }

const readMemos = (filePath: string): Read => {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'none' } : { state: 'unknown' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { state: 'unknown' }
  }
  if (!isObj(parsed) || parsed.version !== 1 || !isObj(parsed.memos)) return { state: 'unknown' }
  return { memos: parsed.memos }
}

/** One parse per version of the file (audit U-11): the Host read and parsed all of handoff.json at every checkpoint. */
const readers = new Map<string, () => Read>()

export function lookupHandoffFile(filePath: string, sessionId: string): HandoffLookup {
  let reader = readers.get(filePath)
  if (!reader) {
    reader = cachedByStampSync(filePath, () => readMemos(filePath))
    readers.set(filePath, reader)
  }
  const read = reader()
  // A passing read error is not kept until the file next changes (final review M-4): asked again next time.
  if ('state' in read && read.state === 'unknown') readers.delete(filePath)
  if ('state' in read) return { state: read.state }
  const memo = Object.hasOwn(read.memos, sessionId) ? read.memos[sessionId] : undefined
  return isObj(memo) && memo.sessionId === sessionId ? { state: 'found', memo: memo as unknown as Handoff } : { state: 'none' }
}

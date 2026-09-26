// The Host's handoff lookup (Host journal P12): a synchronous read of the app's handoff.json, for the
// checkpoint's `handoffRef`. Answers as HandoffStore.lookup does: a missing file is `none` (known
// empty), a file it cannot read or does not recognise is `unknown`, never "none was left".
import { readFileSync } from 'node:fs'
import type { Handoff, HandoffLookup } from './types'

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

export function lookupHandoffFile(filePath: string, sessionId: string): HandoffLookup {
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
  const memo = Object.hasOwn(parsed.memos, sessionId) ? parsed.memos[sessionId] : undefined
  return isObj(memo) && memo.sessionId === sessionId ? { state: 'found', memo: memo as unknown as Handoff } : { state: 'none' }
}

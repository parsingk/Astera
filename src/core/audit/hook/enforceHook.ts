// Enforce's PreToolUse hook (enforce design §5): one call's payload in, the deny JSON or nothing out. Both CLIs let a call
// through when a hook crashes, times out or prints something they cannot read (inventory §19), so a deny is always
// printed here, never left to a failure. The Rules are read as the file holds them at this call; a file the app is just
// renaming into place is read again a few times before the call is judged without them (reads only). Every call it
// sees is written to the session's enforce file: the proof that the hook ran, which the Host asks for, and the record of
// what it stopped. Pure: the files, the clock and the wait come in as functions.
import path from 'node:path'
import { enforceVerdict } from '../enforce'
import { STARTER_POLICY, parseAuditPolicy, type AuditPolicy } from '../policy'
import { resolveAction } from '../resolve'

/** Reads of a rules file that cannot be read for a moment, ENFORCE_RETRY_MS apart, after the first. */
export const ENFORCE_RETRIES = 3
const ENFORCE_RETRY_MS = 20

const UNREADABLE_CALL = 'Blocked by Astera: this call could not be read, so it was not allowed.'

/** The answer both CLIs read as a refusal (inventory §19). */
export const denyJson = (reason: string): string =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })

/** What a call is denied with when nothing of it can be read. */
export const unreadableCallDeny = (): string => denyJson(UNREADABLE_CALL)

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function runEnforceHook(a: {
  stdin: string
  provider: 'claude' | 'codex'
  /** The profile: the folder the script itself is in, where the Rules are. */
  profileDir: string
  /** ASTERA_SESSION: names the enforce file. */
  sessionId: string | undefined
  platform: NodeJS.Platform
  now: () => number
  /** The rules file's text; null when there is none. Throws while it cannot be read. */
  readRules: () => string | null
  append: (file: string, line: string) => void
  sleep: (ms: number) => void
}): string {
  let payload: unknown
  try {
    payload = JSON.parse(a.stdin)
  } catch {
    return unreadableCallDeny()
  }
  if (!isRecord(payload) || typeof payload.tool_name !== 'string' || payload.tool_name === '') return unreadableCallDeny()
  const tool = payload.tool_name
  const cwd = typeof payload.cwd === 'string' && payload.cwd !== '' ? payload.cwd : process.cwd()
  const call = { provider: a.provider, tool, input: payload.tool_input, cwd, base: cwd }

  const policy = readPolicy(a)
  const v = enforceVerdict({ call, policy, profileDir: a.profileDir, platform: a.platform })

  if (a.sessionId !== undefined && a.sessionId !== '') {
    const id = typeof payload.tool_use_id === 'string' ? payload.tool_use_id : null
    const line: Record<string, unknown> = { at: a.now(), tool, id }
    if (v.deny) {
      const r = resolveAction(call)
      Object.assign(line, { blocked: v.ruleId, action: r.action, target: r.target })
    }
    try {
      a.append(path.join(a.profileDir, 'enforce', `${a.sessionId}.jsonl`), JSON.stringify(line) + '\n')
    } catch {
      // The proof is lost for this call; the decision stands
    }
  }
  return v.deny ? denyJson(v.reason) : ''
}

/** The Rules as the file holds them: the starter rules when there is no file, null when it cannot be read or holds none. */
function readPolicy(a: { readRules: () => string | null; sleep: (ms: number) => void }): AuditPolicy | null {
  for (let attempt = 0; ; attempt++) {
    let text: string | null
    try {
      text = a.readRules()
    } catch {
      if (attempt >= ENFORCE_RETRIES) return null
      a.sleep(ENFORCE_RETRY_MS)
      continue
    }
    return text === null ? STARTER_POLICY : parseAuditPolicy(text)
  }
}

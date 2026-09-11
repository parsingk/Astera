import type { ConvPart, ConvTurn, ToolPart } from './convTypes'

// Folds a codex rollout into the same turns the conversation view draws for a Claude transcript.
// Nothing is shared with conversation.ts but those shapes: codex writes a different file, with
// different record names, a different way of pairing a call with its result, and a different way of
// saying a command failed. The rules below are measured, not assumed — 60 rollout files, 5032 lines,
// on 2026-09-11 — and each one earns its line here.
//
// What that measurement found, by count:
//   response_item.payload.type  message 1899 (assistant 1713, user 173, developer 13), reasoning 146,
//                               function_call 186, function_call_output 185, custom_tool_call 9,
//                               custom_tool_call_output 9, tool_search_call 5, tool_search_output 5,
//                               web_search_call 20
//   every other record type     event_msg, session_meta, turn_context — the CLI's own bookkeeping,
//                               none of it anything a person said or an agent did
//
// Ten assistant records for every user record, so an assistant turn is a *run* of them, exactly as it
// is on the Claude side.

/** Roles that are not the conversation. `developer` carries skill instructions and multi-agent
 *  preamble (codexParser.ts measured a 20KB `<skills_instructions>` in that role) — nobody said it. */
const DROPPED_ROLES = new Set(['developer', 'system'])

/** How the CLI's own preamble opens. A session's first user record is written by codex, not typed by
 *  anyone: measured across this machine's rollouts it is the project's AGENTS.md, the environment
 *  block, and a plugin listing — often two of them as two parts of the one record, with the person's
 *  actual first message arriving as a separate record after it.
 *
 *  So the test is per part, not on the record's joined text: a record whose *every* part opens with
 *  one of these is preamble and is dropped, and a record with even one part that does not is
 *  something a person wrote. Getting that backwards either eats the opening message or prints twenty
 *  kilobytes of instructions as though someone had said them.
 *
 *  Dropping is not enough on its own: like a dropped record on the Claude side it must not end an
 *  assistant run either, or a turn would be cut in half by something that is not on screen. */
const INJECTED_PART_PREFIXES = [
  '<environment_context>',
  '<user_instructions>',
  '<recommended_plugins>',
  '# AGENTS.md instructions'
]

const isInjectedPart = (text: string): boolean =>
  INJECTED_PART_PREFIXES.some((prefix) => text.startsWith(prefix))

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** The text of a codex message, whose parts are `input_text` (user) or `output_text` (assistant).
 *  Any other part type contributes nothing rather than an empty string. */
function messageTexts(payload: Record<string, unknown>): string[] {
  const content = payload.content
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const part of content) {
    if (!isRecord(part)) continue
    const t = part.type
    if (t !== 'input_text' && t !== 'output_text' && t !== 'text') continue
    const text = str(part.text)
    if (text !== null) out.push(text)
  }
  return out
}

/** One field out of a call's arguments, which arrive as a JSON *string* rather than an object. A call
 *  whose arguments will not parse still draws a row: the name alone is worth more than nothing, and a
 *  row that vanishes is a tool call the reader never learns ran. */
function argField(raw: unknown, keys: readonly string[]): string | null {
  const text = str(raw)
  if (text === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  for (const key of keys) {
    const v = str(parsed[key])
    if (v !== null) return v
  }
  return null
}

/** What an `apply_patch` acts on, read off the patch envelope's own header line. */
function patchTarget(input: unknown): string | null {
  const text = str(input)
  if (text === null) return null
  const m = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m.exec(text)
  return m === null ? null : m[1].trim()
}

/** Whether a shell result says the command failed.
 *
 *  codex has no ok/error field: the exit code is the first line of the output text, as
 *  "Exit code: 0", with the wall time and the output under it. An output with no such line is not a
 *  failure — plenty of tools answer in plain prose — so only an explicit non-zero counts as one. */
function shellOutcome(output: unknown): { ok: boolean; detail: string } {
  const text = str(output)
  if (text === null) return { ok: true, detail: '' }
  const m = /^Exit code:\s*(-?\d+)/m.exec(text)
  if (m === null) return { ok: true, detail: '' }
  const code = Number(m[1])
  return { ok: code === 0, detail: code === 0 ? '' : `exit ${code}` }
}

/** Whether an `apply_patch` applied. Measured: a success opens with `Success.`, a refusal opens with
 *  the reason instead. */
function patchOutcome(output: unknown): { ok: boolean; detail: string } {
  const text = str(output)
  if (text === null) return { ok: true, detail: '' }
  return { ok: text.startsWith('Success'), detail: '' }
}

/**
 * The same contract as reduceTranscript (conversation.ts): lines in, turns out, and a `pending` map
 * the caller may carry across reads so a call resolves when its result lands in a later one.
 */
export function reduceCodexRollout(
  lines: string[],
  pending: Map<string, ToolPart> = new Map()
): ConvTurn[] {
  const turns: ConvTurn[] = []
  let current: ConvTurn | null = null // the assistant run being built, or null between runs

  const startAssistant = (id: string, timestamp: string | null): ConvTurn => {
    if (current !== null) return current
    const turn: ConvTurn = { id, role: 'assistant', parts: [] }
    if (timestamp !== null) turn.timestamp = timestamp
    turns.push(turn)
    current = turn
    return turn
  }

  for (const raw of lines) {
    let obj: unknown
    try {
      obj = JSON.parse(raw)
    } catch {
      continue // a torn or truncated line
    }
    if (!isRecord(obj)) continue
    if (obj.type !== 'response_item') continue // event_msg / session_meta / turn_context: bookkeeping
    const payload = obj.payload
    if (!isRecord(payload)) continue
    const kind = str(payload.type)
    const stamp = str(obj.timestamp)

    if (kind === 'message') {
      const role = str(payload.role)
      if (role === null || DROPPED_ROLES.has(role)) continue
      const texts = messageTexts(payload)
      const text = texts.join('')
      if (role === 'user') {
        // Preamble, so neither drawn nor allowed to end the run it happens to sit inside.
        if (texts.length > 0 && texts.every(isInjectedPart)) continue
        if (text === '') continue
        current = null
        const turn: ConvTurn = {
          id: str(payload.id) ?? stamp ?? `user-${turns.length}`,
          role: 'user',
          parts: [{ kind: 'text', text }]
        }
        if (stamp !== null) turn.timestamp = stamp
        turns.push(turn)
        continue
      }
      if (text === '') continue
      const turn = startAssistant(str(payload.id) ?? stamp ?? `assistant-${turns.length}`, stamp)
      const part: ConvPart = { kind: 'text', text }
      turn.parts.push(part)
      continue
    }

    // Nothing renderable: the summary is empty and the body is encrypted (measured — 146 of them, not
    // one with a readable body).
    if (kind === 'reasoning') continue

    if (kind === 'function_call' || kind === 'custom_tool_call' || kind === 'tool_search_call') {
      const callId = str(payload.call_id) ?? str(payload.id)
      if (callId === null) continue
      const target =
        (kind === 'custom_tool_call' ? patchTarget(payload.input) : null) ??
        argField(payload.arguments, ['command', 'path', 'file_path', 'pattern', 'query']) ??
        str(payload.query) ??
        ''
      const turn = startAssistant(str(payload.id) ?? callId, stamp)
      const part: ToolPart = {
        kind: 'tool',
        id: callId,
        name: str(payload.name) ?? kind,
        target,
        outcome: null
      }
      turn.parts.push(part)
      pending.set(callId, part)
      continue
    }

    if (
      kind === 'function_call_output' ||
      kind === 'custom_tool_call_output' ||
      kind === 'tool_search_output'
    ) {
      const callId = str(payload.call_id)
      if (callId === null) continue
      const part = pending.get(callId)
      if (part === undefined) continue // its call fell outside this window
      part.outcome =
        kind === 'custom_tool_call_output'
          ? patchOutcome(payload.output)
          : shellOutcome(payload.output)
      pending.delete(callId)
      continue
    }

    // A search carries its own result: there is no second record to wait for, so it is drawn settled.
    if (kind === 'web_search_call') {
      const id = str(payload.id)
      if (id === null) continue
      const action = isRecord(payload.action) ? payload.action : {}
      const turn = startAssistant(id, stamp)
      turn.parts.push({
        kind: 'tool',
        id,
        name: 'web_search',
        target: str(action.query) ?? '',
        outcome: { ok: str(payload.status) !== 'failed', detail: '' }
      })
    }
  }

  return turns.filter((t) => t.parts.length > 0)
}

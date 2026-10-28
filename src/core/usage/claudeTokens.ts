import type { TokensSpent } from '../types'

// The tokens a Claude session spent, one API response at a time (observe mode design §10). Pure functions.
//
// Why not the statusLine: its `context_window.total_input_tokens` and `total_output_tokens` are not the session's
// running total. Measured over ten captures from Claude Code 2.1.306 to 2.1.309, they equal the latest request's
// `current_usage` (its input and both caches, its output), the same figure the context chip reads; the only running
// figure there is `cost.total_cost_usd`, which is money. What Claude does write once per response is the response's
// own usage, on its assistant message: in the transcript (and, for a sub-agent, in that agent's own file beside it)
// and on the stream a chat reads. Summed, those are the session's tokens, and nothing is estimated.
//
// - A message is written as one line per content block, every line with the message's usage (199 messages over 409
//   lines in one measured transcript, never two figures for one message), so a message is counted once, by its id.
//   Met again with a larger figure, only the difference is added.
// - `input` is the input tokens and both cache counts, every token the model read, as Codex counts its input
//   (cached tokens inside it), so the two providers' figures can be added.
// - A line written before `since` (epoch ms) was a session before this one: a transcript resumed from history or
//   copied by a roll holds those turns. A line with no time (a chat frame from an older CLI) is taken as now.
// - History a stream replays (`historical`) is not a response this session got.

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** A reader of one session's lines, as many batches as it is handed: the responses in each batch it had not counted. */
export function claudeTokenReader(since: number): (lines: readonly string[]) => TokensSpent[] {
  /** What each message was counted at, by its id. */
  const counted = new Map<string, { input: number; output: number }>()
  return (lines) => {
    const out: TokensSpent[] = []
    for (const line of lines) {
      if (!line.includes('"assistant"') || !line.includes('"usage"')) continue
      let o: Record<string, unknown> | null
      try {
        o = obj(JSON.parse(line))
      } catch {
        continue
      }
      if (!o || o.type !== 'assistant' || o.historical === true) continue
      const message = obj(o.message)
      const id = typeof message?.id === 'string' ? message.id : null
      const usage = obj(message?.usage)
      if (id === null || !usage) continue
      const at = typeof o.timestamp === 'string' ? o.timestamp : null
      if (at !== null && !(Date.parse(at) >= since)) continue
      const input = count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens)
      const output = count(usage.output_tokens)
      const before = counted.get(id) ?? { input: 0, output: 0 }
      const grew = { input: Math.max(0, input - before.input), output: Math.max(0, output - before.output) }
      if (grew.input + grew.output === 0) continue
      counted.set(id, { input: Math.max(input, before.input), output: Math.max(output, before.output) })
      out.push({ at, ...grew })
    }
    return out
  }
}

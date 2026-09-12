import type { ModelDescriptor } from './types'

/** One row of the model menu: what the pane sends, and what it shows. */
export interface CliModelChoice {
  /** What the pane acts on — a name for Claude's `/model`, and for codex the name to look for on its
   *  own picker screen (core/models/codexPicker.ts finds the digit that takes that row). */
  key: string
  /** The CLI's own name for it. Not translated: these are product names. */
  label: string
}

/**
 * The models a session can switch to, out of what its CLI answered (main/ipc.ts's
 * `conversation.models`, the same list and cache settings uses).
 *
 * Asked rather than kept: which models an account can reach depends on its subscription and its
 * organisation's policy, and nothing in this app can see either. A list written here would be a
 * guess that goes quietly stale — and for codex it would be worse than stale, because its picker is
 * answered by position.
 */
export function modelChoicesOf(models: readonly ModelDescriptor[]): CliModelChoice[] {
  return models.map((m) => ({ key: m.id, label: m.name }))
}

/**
 * The reasoning levels the model a session is on accepts, out of that same answer.
 *
 * Per model, because they genuinely differ: Haiku takes none at all, and gpt-5.5 stops at xhigh
 * where gpt-6-astra goes to ultra (both measured 2026-09-12). `current` is what the CLI reports it is
 * running, which is a display name on one side (`Opus 5 (1M context)`) and an id on the other
 * (`gpt-5.6-sol`), so both are compared. A model the list does not carry falls back to the one the
 * CLI calls its default, and then to nothing — an empty list draws no effort rows rather than rows
 * that would be refused.
 */
export function effortChoicesOf(
  models: readonly ModelDescriptor[],
  current: string | null
): CliModelChoice[] {
  const wanted = current?.trim().toLowerCase() ?? ''
  const match =
    models.find((m) => m.id.toLowerCase() === wanted || m.name.toLowerCase() === wanted) ??
    models.find((m) => m.isDefault === true)
  return (match?.effortLevels ?? []).map((level) => ({ key: level, label: level }))
}

/**
 * What codex calls a reasoning level on its own picker, keyed by the name its model list uses.
 *
 * The two do not agree, and only the picker's wording can be found on the screen: the list says
 * `xhigh`, the screen says `Extra high` (measured 2026-09-12). Hence this, and hence its gaps —
 * `max` and `ultra` are real levels that codex keeps behind a `More reasoning…` row, one screen
 * further in than the walk goes, so they are not offered here and the menu's terminal row is what
 * reaches them.
 */
export const CODEX_EFFORT_ROWS: Readonly<Record<string, string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high'
}

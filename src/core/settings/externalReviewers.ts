// External reviewers: third-party coding agents (spoken to over ACP) that can review a Task in place of
// the built-in cross-review. app-settings.json holds which are registered (`externalReviewers`) and
// which one is chosen (`reviewBy`); the app's store and the Host's read narrow them with the same function.
// Node-free (the renderer's settings pane and AppApi in types.ts use it): the Host's file read is in
// externalReviewersFile.ts.

export interface ExternalReviewer { id: string; name: string; command: string; args: string[] }
export interface ReviewerSettings { reviewers: ExternalReviewer[]; reviewBy: string | null }

export const MAX_EXTERNAL_REVIEWERS = 10
const MAX_NAME_LENGTH = 40
const MAX_ARGS = 20
const ID_PATTERN = /^ext_[0-9a-f]{8}$/
const LINE_BREAK = /[\r\n]/

export const EMPTY_REVIEWER_SETTINGS: ReviewerSettings = { reviewers: [], reviewBy: null }

export const REVIEWER_PRESETS: readonly { key: 'gemini' | 'copilot' | 'opencode'; name: string; command: string; args: string[] }[] = [
  { key: 'gemini', name: 'Gemini CLI', command: 'gemini', args: ['--acp'] },
  { key: 'copilot', name: 'Copilot CLI', command: 'copilot', args: ['--acp'] },
  { key: 'opencode', name: 'OpenCode', command: 'opencode', args: ['acp'] }
]

function reviewerOf(raw: unknown): ExternalReviewer | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || !ID_PATTERN.test(o.id)) return null
  if (typeof o.name !== 'string' || typeof o.command !== 'string') return null
  const name = o.name.trim()
  const command = o.command.trim()
  if (!name || name.length > MAX_NAME_LENGTH || LINE_BREAK.test(name)) return null
  if (!command || LINE_BREAK.test(command)) return null
  if (!Array.isArray(o.args) || o.args.length > MAX_ARGS || !o.args.every((a) => typeof a === 'string')) return null
  return { id: o.id, name, command, args: [...(o.args as string[])] }
}

/** Narrowing over the parsed app-settings.json object (fields `externalReviewers`, `reviewBy`). Never
 *  throws: a hand-edited file that does not fit reads as fewer reviewers, down to none (automatic). */
export function reviewerSettingsOf(obj: Record<string, unknown> | null): ReviewerSettings {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return { reviewers: [], reviewBy: null }
  const raw = obj.externalReviewers
  const reviewers: ExternalReviewer[] = []
  if (Array.isArray(raw)) {
    const seen = new Set<string>()
    for (const item of raw) {
      if (reviewers.length >= MAX_EXTERNAL_REVIEWERS) break
      const r = reviewerOf(item)
      if (!r || seen.has(r.id)) continue
      seen.add(r.id)
      reviewers.push(r)
    }
  }
  const by = obj.reviewBy
  return { reviewers, reviewBy: typeof by === 'string' && reviewers.some((r) => r.id === by) ? by : null }
}

export function newExternalReviewerId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(4))
  return 'ext_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function chosenReviewer(s: ReviewerSettings): ExternalReviewer | null {
  return s.reviewBy === null ? null : (s.reviewers.find((r) => r.id === s.reviewBy) ?? null)
}

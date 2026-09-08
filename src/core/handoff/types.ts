// src/core/handoff/types.ts
// The handoff memo an agent leaves while it works, and what the app stores around it. Pure types —
// the shape is shared by the parser (core), the store (main), the CLI server (main) and the briefing
// renderer (core), so it lives where all four can import it without touching electron or fs.
import type { Provider } from '../types'

export type VerificationType = 'test' | 'build' | 'lint' | 'typecheck' | 'review' | 'other'
export type VerificationStatus = 'passed' | 'failed' | 'unknown'

/** What the agent writes. Every field is optional on input; parseHandoffBody normalises to this. */
export interface HandoffBody {
  objective?: string
  completed: string[]
  currentProblems: string[]
  nextActions: string[]
  /** The person's explicit constraints, as close to their words as the agent can manage. This is
   *  the field the whole feature exists for (spec §2): nothing else in the app can observe them. */
  constraints: string[]
  decisions: Array<{ decision: string; reason?: string }>
  verification: Array<{ type: VerificationType; status: VerificationStatus; summary?: string }>
  relevantFiles: string[]
}

/** What the app stores: the body plus the facts only the app can vouch for. None of the five extra
 *  fields is ever taken from the agent's document — an agent asked for a commit hash will sometimes
 *  give the wrong one. */
export interface Handoff extends HandoffBody {
  version: 1
  sessionId: string
  projectPath: string
  provider: Provider
  /** ISO, the app's clock at save time. */
  createdAt: string
  /** Read by the app at save time. null when the folder is not a repository or git failed. */
  git: { branch: string | null; head: string | null } | null
}

/** What a reader gets back. `unknown` is a store that could not be read (or a caller with no store
 *  at all) — it is never rendered as "none was left", which would be a claim nobody checked. */
export type HandoffLookup =
  | { state: 'found'; memo: Handoff }
  | { state: 'none' }
  | { state: 'unknown' }

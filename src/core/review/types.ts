// What the agent-aware review answers (Phase 3 Part 4), shared with the renderer: who changed a file
// (core/review/attribution.ts) and a review finding placed on a diff (core/review/diffFindings.ts). Node-free: the
// renderer imports this file.
import type { FindingChange, FindingState, ReviewSeverity } from '../orchestration/types'
import type { Provider } from '../providers/meta'

export type AttributionKind = 'agent' | 'mixed' | 'unknown'
export type AttributionWhy = 'no-range' | 'not-fast-forward' | 'shared-folder-live' | 'overlap'
export type EvidenceLevel = 'recorded-range' | 'observe-audit'

export interface AttemptEvidence {
  dispatchId: string
  taskId: string
  provider: Provider
  accountId: string
  sessionId: string
  nativeSessionId?: string
  cwd: string
  base: string
  /** Null: the attempt is still open and its range runs to the working tree. */
  head: string | null
}

export interface FileAttribution {
  kind: AttributionKind
  /** The attempts whose ranges changed the file, oldest first. */
  evidence: AttemptEvidence[]
  /** For an agent: the recorded range alone, or confirmed by the observe audit's write records. */
  level?: EvidenceLevel
  /** For mixed and unknown: why. */
  why?: AttributionWhy
}

export type FindingPlacement = { line: number } | 'other-revision' | 'file'

export interface DiffFinding {
  ref: string
  taskId: string
  title: string
  severity: ReviewSeverity
  line?: number
  state: FindingState
  note?: string
  history: FindingChange[]
  /** The head the review began at, when the Host anchored it. */
  head?: string
  placement: FindingPlacement
}

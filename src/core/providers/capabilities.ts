// What each kind of worker can do in Astera (Phase 5 A1, spec §7): the common contract a provider is described by. Pure
// data, so the app, the Host and the CLI say the same thing. A capability a worker lacks is said to be missing, never
// emulated: an external agent that cannot resume is not resumed by Astera pretending it can.
import type { Provider } from './meta'

export interface ProviderCapabilities {
  /** Picked up again after a restart or an account roll (the CLI's resume, or Smart Resume's checkpoint). */
  resume: boolean
  /** How a tool's use is approved: in the session itself (a terminal prompt or a chat card), through Astera (a question
   *  to the person, or the bypass mode), or not at all. */
  toolApproval: 'interactive' | 'astera' | 'none'
  /** Its work arrives as structured events Astera records (chat sessions, ACP updates), not only as terminal text. */
  structuredStream: boolean
  /** A usage limit is detected, with its reset time. */
  limits: boolean
  /** Its account's usage is shown as it is spent. */
  usageMeter: boolean
  /** A limit moves the work to the next account. */
  accountRolling: boolean
  /** It can be stopped, its process ended. */
  cancel: boolean
  /** A model is chosen for it. */
  models: boolean
  /** It can start in its CLI's own sandbox (sandbox design §6). */
  sandbox: boolean
}

export const PROVIDER_CAPABILITIES: Record<Provider, ProviderCapabilities> = {
  claude: { resume: true, toolApproval: 'interactive', structuredStream: true, limits: true, usageMeter: true, accountRolling: true, cancel: true, models: true, sandbox: true },
  // Codex has no status line, so no live usage meter (PROVIDER_META.usesStatusLine)
  codex: { resume: true, toolApproval: 'interactive', structuredStream: true, limits: true, usageMeter: false, accountRolling: true, cancel: true, models: true, sandbox: true }
}

/** An external agent spoken to over ACP, as this integration runs it: one prompt turn in the Task's worktree, its
 *  permission requests answered through Astera, its updates recorded; no account, so no limits, meter or rolling; not
 *  resumed after a Host restart even when the agent offers loadSession. */
export const EXTERNAL_AGENT_CAPABILITIES: ProviderCapabilities = {
  resume: false,
  toolApproval: 'astera',
  structuredStream: true,
  limits: false,
  usageMeter: false,
  accountRolling: false,
  cancel: true,
  models: false,
  sandbox: false
}

const FLAGS = ['resume', 'structuredStream', 'limits', 'usageMeter', 'accountRolling', 'cancel', 'models', 'sandbox'] as const

/** The capabilities `c` lacks, in a fixed order. */
export const capabilityGaps = (c: ProviderCapabilities): (typeof FLAGS)[number][] => FLAGS.filter((f) => !c[f])

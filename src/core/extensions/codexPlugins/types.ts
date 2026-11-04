// The outcome rows of the Codex plugin sync (Codex plugin sharing design §5), apart from state.ts, which reads and writes
// them with node modules: the settings screen draws them, and the web build holds no file of node-only code.

export type CodexPluginFailureCode =
  | 'marketplace-taken'
  | 'codex-unsupported'
  | 'config-unreadable'
  | 'hooks-unreadable'
  | 'refused'
  | 'timed-out'

export interface CodexPluginAccountState {
  accountId: string
  /** Plugin name to the version Codex reports installed from this profile's marketplace. */
  installed: Record<string, string>
  waiting: boolean
  failure?: { message: string; code?: CodexPluginFailureCode }
  /** Own plugin ids (`name@marketplace`) Astera set to enabled = false (C1). */
  turnedOff: string[]
  at: string
}

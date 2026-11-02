// Claude Code plugins shared across accounts: Astera installs each one once into its own folder
// (`extensions/claude-plugins`) and records it in a store of its own (`extensions/claude-plugins.json`), not in the
// extension registry, so an older build that reads the registry never meets a plugin. "plugin" alone means an Astera
// plugin in this codebase; every name here says `ClaudePlugin`.

/** Where a marketplace comes from: Claude Code's own marketplace source, as `known_marketplaces.json` records it. */
export type MarketplaceSource =
  | { source: 'github'; repo: string; ref?: string }
  | { source: 'git'; url: string; ref?: string }
  | { source: 'url'; url: string }
  | { source: 'directory'; path: string }
  | { source: 'file'; path: string }

/** A plugin another shared plugin needs, as it stands in Astera's folder. */
export interface ClaudePluginDependency {
  id: string
  version: string
  installPath: string
}

export interface SharedClaudePlugin {
  /** `<name>@<marketplace>`, Claude Code's own plugin id. */
  id: string
  name: string
  marketplace: string
  source: MarketplaceSource
  version: string
  installPath: string
  dependencies: ClaudePluginDependency[]
  /** The account the plugin was taken from. */
  importedFrom: string
  enabled: boolean
  addedAt: string
  enabledAt?: string
  lastUpdated: string
  /** Covers the plugin's catalog entry in Astera's clone of the marketplace, plus its folder's digest when the source
   *  is relative. A different one later means "update available". */
  fingerprint: string
  /** What the last check found; absent while nothing newer is known. */
  update?: { version: string | null; fingerprint: string; checkedAt: string }
}

export interface ClaudePluginStore {
  version: 1
  plugins: SharedClaudePlugin[]
  lastCheck?: { at: string; error?: string }
}

/** Why a plugin cannot be shared. */
export type ClaudePluginRefusal = 'user-config' | 'source-credential' | 'source-unsupported' | 'not-from-marketplace' | 'name-taken'

// The shapes below cross to the renderer (Settings › MCP & Skills), so they live here, in a file with no imports, rather
// than beside the node code that makes them (discover.ts, operations.ts).

export interface ClaudePluginHolder {
  accountId: string
  version: string
  enabled: boolean
}

export type DiscoveredClaudePlugin = {
  id: string
  name: string
  marketplace: string
  /** Every Claude account holding the plugin at user scope, in the order the accounts were given. */
  holders: ClaudePluginHolder[]
  /** From the first account that holds the plugin and knows its marketplace; null when none does, when the source is one
   *  Astera cannot hand to `claude plugin marketplace add`, and when the address or the recorded headers hold a
   *  credential, whatever the refusal: this object goes to the renderer, and it must not hold the credential. */
  source: MarketplaceSource | null
  /** That account; the first holder when no holder knows the marketplace. */
  sourceAccountId: string
} & ({ shareable: true } | { shareable: false; reason: ClaudePluginRefusal })

export type ClaudePluginJobKind = 'share' | 'update' | 'check' | 'remove'

/** Why a job failed when Astera decided it, so the settings tab can say it in the person's language. A failure Claude
 *  Code reported has no code; its `message` is Claude Code's own. */
export type ClaudePluginFailureCode =
  | 'already-shared' // a share of an id the store already holds
  | 'not-shared' // an update or removal of an id the store does not hold
  | 'not-shareable' // a share of something that is not a plugin id, or whose source `marketplace add` cannot take
  | 'marketplace-mismatch' // the home knows the marketplace's name from another source (M10)
  | 'home-unreadable' // the home's known_marketplaces.json cannot be read, so a mismatch cannot be ruled out
  | 'not-listed' // Claude Code answered ok but does not list the plugin
  | 'dependency-missing' // a dependency is not installed, or a manifest naming them cannot be read
  | 'catalog-unreadable' // the plugin's catalog entry cannot be read, so its updates could not be found
  | 'store-unreadable' // the plugin store is damaged or cannot be read
  | 'refused' // nothing was run: the arguments hold cmd.exe syntax and `claude` is a `.cmd` (cli.ts)
  | 'timed-out' // `claude` did not finish in time and was stopped

export interface ClaudePluginJob {
  id: string
  kind: ClaudePluginJobKind
  /** The plugin id; absent for a check. */
  target?: string
  state: 'queued' | 'running' | 'done' | 'failed' | 'needs-confirmation'
  /** Where the job is, or where it stopped. `install` is the install, update or uninstall command. */
  step?: 'marketplace' | 'install' | 'record'
  /** Set on a failure Astera decided; absent on one Claude Code reported. */
  code?: ClaudePluginFailureCode
  /** Why it failed, in English: Claude Code's message, or Astera's detail for `code`. */
  message?: string
  /** What the marketplace wants run, to show the person as it is; confirming repeats the action with `sha256`. */
  command?: { text: string; sha256: string }
  /** When the job was asked for. */
  startedAt: string
  endedAt?: string
}

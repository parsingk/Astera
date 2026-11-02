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

// Where the Agent Control Plane keeps its state (release 1 design §4.1): one place for every path under the profile
// folder, so the Host, the app and the CLI cannot drift apart. The profile folder itself still comes from where it
// comes from today (main's userData, the Host's ASTERA_HOST_PROFILE_DIR, the CLI's discovery).
import path from 'node:path'

export interface ExtensionPaths {
  /** The shared extensions: `{ version, entries }`. */
  registry: string
  /** The shared Claude Code plugins: `{ version, plugins }`, written by the Host alone. Not the registry, so an older
   *  build that reads the registry never meets a plugin. */
  claudePlugins: string
  /** Where Astera installs each shared Claude Code plugin once: Claude Code's own config layout, used only by
   *  `claude plugin …` commands, never as a session's `CLAUDE_CONFIG_DIR`. */
  claudePluginHome: string
  /** The Codex copies of the shared plugins and the one marketplace file that lists them
   *  (`.agents/plugins/marketplace.json`): the folder every Codex account's `codex plugin marketplace add` is given.
   *  Never a Codex account's own folder. */
  codexPluginHome: string
  /** What the shared plugins' MCP servers keep between runs, one folder per plugin, standing in for
   *  `${CLAUDE_PLUGIN_DATA}` in the Codex copies; kept across versions, shared by the Codex accounts. */
  codexPluginData: string
  /** Canonical skill folders, one per skill name. */
  skills: string
  /** Canonical Claude slash commands, `<name>.md`. */
  commands: string
  /** Canonical Claude subagents, `<name>.md`. */
  agents: string
  /** The owner-only secret store for MCP servers' secret environment values. */
  secrets: string
  /** What was copied into which account, with the hashes the next sync compares. */
  materializedState: string
  /** When a session was last handed each shared Claude Code plugin folder: one file per folder, holding its path, whose
   *  mtime is the last use. Claude Code never sweeps Astera's plugin folder, so Astera does, sparing a recent use. */
  claudePluginUse: string
  /** How the last Codex pass went for each Codex account, written by the Host alone. */
  codexPluginAccounts: string
  /** Taken around Astera's writes to a Codex account's `config.toml`, so the settings import and the plugin pass never
   *  write one at once. */
  codexConfigLock: string
  /** Copies Astera replaced or restored, kept before it wrote over them. */
  backups: string
  /** Generated Claude `--mcp-config` files, named by their content hash. */
  generatedMcp: string
}

export function extensionPaths(profileDir: string): ExtensionPaths {
  const ext = path.join(profileDir, 'extensions')
  const state = path.join(profileDir, 'extension-state')
  return {
    registry: path.join(ext, 'registry.json'),
    claudePlugins: path.join(ext, 'claude-plugins.json'),
    claudePluginHome: path.join(ext, 'claude-plugins'),
    codexPluginHome: path.join(ext, 'codex-plugins'),
    codexPluginData: path.join(ext, 'codex-plugin-data'),
    skills: path.join(ext, 'skills'),
    commands: path.join(ext, 'commands'),
    agents: path.join(ext, 'agents'),
    secrets: path.join(ext, 'secrets'),
    materializedState: path.join(state, 'materialized.json'),
    claudePluginUse: path.join(state, 'claude-plugin-use'),
    codexPluginAccounts: path.join(state, 'codex-plugin-accounts.json'),
    codexConfigLock: path.join(state, 'codex-config.lock'),
    backups: path.join(state, 'backups'),
    generatedMcp: path.join(profileDir, 'materialized', 'mcp')
  }
}

export interface ProfilePaths {
  /** The Agent Profiles: `{ version, profiles }`. */
  agentProfiles: string
  /** The agent profile each conversation ran as, by the provider's conversation id: `{ version, conversations }`. */
  agentProfileConversations: string
  /** Observe mode's rules and the mode itself: `{ version, mode, rules, otherwise }`. Not `policy.json`, which is the
   *  release update feed. */
  auditPolicy: string
  /** Observe mode's records: one `YYYY-MM-DD.jsonl` per local day, written by the Host alone. */
  auditRecords: string
  /** The tokens each session spent for a Dispatch or a Run's coordinator: `{ version, spent }`, written by the Host
   *  alone, in every mode (observe mode design §10). */
  tokenTotals: string
  /** The Credentials list (credentials design §4): `{ version, entries, mcpHide }`, written by the Host alone. */
  credentials: string
  /** Empty folders and files a hidden CLI login's configuration is pointed at (credentials design §5). */
  credentialEmpty: string
  /** Credential-use records: one `YYYY-MM-DD.jsonl` per local day, written by the Host alone (credentials design §6). */
  credentialUses: string
  /** The uses of shared skills, commands and agents the CLIs reported while observing (lifecycle design §4.12): one
   *  `YYYY-MM-DD.jsonl` per local day, written by the Host alone, kept as the tool calls are. */
  extensionUses: string
  /** Enforce's hook writes each call it sees here, one file per session (enforce design §5): the proof it ran, and what it
   *  blocked. */
  enforceEvents: string
  /** The findings the person set aside (lifecycle design §6): `{ version, ignored }`, written by the Host alone. */
  findingsIgnored: string
  /** When this release first ran on the profile (lifecycle plan ruling 2): `{ version, since }`, the start of every
   *  history it began recording. */
  findingsHistory: string
}

export function profilePaths(profileDir: string): ProfilePaths {
  return {
    agentProfiles: path.join(profileDir, 'agent-profiles.json'),
    agentProfileConversations: path.join(profileDir, 'agent-profile-conversations.json'),
    auditPolicy: path.join(profileDir, 'audit-policy.json'),
    auditRecords: path.join(profileDir, 'audit'),
    tokenTotals: path.join(profileDir, 'token-totals.json'),
    credentials: path.join(profileDir, 'credentials.json'),
    credentialEmpty: path.join(profileDir, 'credentials', 'empty'),
    credentialUses: path.join(profileDir, 'credential-uses'),
    extensionUses: path.join(profileDir, 'extension-uses'),
    enforceEvents: path.join(profileDir, 'enforce'),
    findingsIgnored: path.join(profileDir, 'findings-ignored.json'),
    findingsHistory: path.join(profileDir, 'findings-history.json')
  }
}

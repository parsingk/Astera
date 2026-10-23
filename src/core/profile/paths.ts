// Where the Agent Control Plane keeps its state (release 1 design §4.1): one place for every path under the profile
// folder, so the Host, the app and the CLI cannot drift apart. The profile folder itself still comes from where it
// comes from today (main's userData, the Host's ASTERA_HOST_PROFILE_DIR, the CLI's discovery).
import path from 'node:path'

export interface ExtensionPaths {
  /** The shared extensions: `{ version, entries }`. */
  registry: string
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
    skills: path.join(ext, 'skills'),
    commands: path.join(ext, 'commands'),
    agents: path.join(ext, 'agents'),
    secrets: path.join(ext, 'secrets'),
    materializedState: path.join(state, 'materialized.json'),
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
}

export function profilePaths(profileDir: string): ProfilePaths {
  return {
    agentProfiles: path.join(profileDir, 'agent-profiles.json'),
    agentProfileConversations: path.join(profileDir, 'agent-profile-conversations.json'),
    auditPolicy: path.join(profileDir, 'audit-policy.json')
  }
}

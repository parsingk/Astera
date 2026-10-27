// Observe mode's shapes (design §6-§9) with nothing beside them: the resolver, the rules and the record store import
// node, and the renderer cannot, so the screens read the same types from here. Each module that owns a shape re-exports
// it, so a caller keeps importing it from where it lives.

export type AuditAction =
  | 'process.execute'
  | 'git.read'
  | 'git.local.write'
  | 'git.remote.write'
  | 'github.pr.create'
  | 'github.write'
  | 'package.install'
  | 'filesystem.read'
  | 'filesystem.write'
  | 'filesystem.delete'
  | 'network.request'
  | 'mcp.call'
  | 'agent.spawn'
  | 'other'

export type Confidence = 'exact' | 'high' | 'heuristic' | 'unknown'

/** What one command of a line does, and where, for a rule to judge on its own. */
export interface CommandFacts {
  action: AuditAction
  /** Left out when the command names no path. */
  insideProject?: boolean
}

/** `compatibility`: nothing is observed, as before observe mode existed. `enforce` is not offered in this phase. */
export type AuditMode = 'compatibility' | 'observe' | 'enforce'

export interface AuditRule {
  id: string
  effect: 'allow' | 'deny'
  /** An action exactly, or a prefix ending in `*` (`git.*`). */
  action: string
  /** Left out: wherever the call was. */
  scope?: 'inside-project' | 'outside-project'
}

export interface AuditPolicy {
  version: 1
  mode: AuditMode
  rules: AuditRule[]
  /** What a call no rule matches gets. */
  otherwise: 'allow' | 'deny'
}

/** `blocked`: Enforce's hook stopped the call before it ran (enforce design §5), whatever the rules say at the read. */
export type AuditDecision = 'allow' | 'would-deny' | 'unknown' | 'blocked'

export type CoverageClass = 'shell' | 'file-read' | 'file-write' | 'mcp' | 'network'

/** Why a class is only partly seen, as a key the screens and the CLI put in words. The sandbox's table adds two:
 *  `runtime-measured`, blocked by the runtime Claude Code's sandbox runs on (srt), which was measured, while Claude Code's
 *  own use of it was not; `file-tools-only`, Claude Code on Windows, whose file tools alone are kept out; `bus-path-only`,
 *  Codex on Linux, whose deny names the session bus by its file path (an abstract-socket bus is not denied). */
export type CoverageNote =
  | 'web-tools-only'
  | 'shell-text-only'
  | 'web-search-and-shell-text'
  | 'interactive-input'
  | 'runtime-measured'
  | 'file-tools-only'
  | 'bus-path-only'

export interface CoverageCell {
  /** `enforced`: Enforce's hook decides every call of the class before it runs (COVERAGE_ENFORCE), or the sandbox
   *  stops it (SANDBOX_COVERAGE). In the sandbox's table `seen` is what it lets through: the network (E3). */
  level: 'seen' | 'partial' | 'none' | 'enforced'
  note?: CoverageNote
}

export interface CoverageRow {
  provider: 'claude' | 'codex'
  kind: 'terminal' | 'chat'
  classes: Record<CoverageClass, CoverageCell>
}

/** What the sandbox keeps a session from (sandbox design §6): writing outside its folders, reading the folders holding
 *  logins (E6), the OS's credential store, and the network, which it allows. */
export type SandboxCoverageClass = 'write' | 'sensitive' | 'stores' | 'network'

/** One CLI's sandbox on one OS, terminal and chat alike (core/sandbox/coverage.ts SANDBOX_COVERAGE). */
export interface SandboxCoverageRow {
  provider: 'claude' | 'codex'
  os: 'win32' | 'darwin' | 'linux'
  classes: Record<SandboxCoverageClass, CoverageCell>
}

/** Where a record came from (design §5). The provider is the first word. */
export type AuditSource = 'claude-hook' | 'claude-chat' | 'codex-rollout' | 'codex-chat' | 'codex-hook'

export interface AuditRecord {
  id: string
  /** When the call happened, ISO. */
  at: string
  /** The app's id for the session (ASTERA_SESSION). */
  sessionId: string
  provider: 'claude' | 'codex'
  kind: 'terminal' | 'chat'
  accountId: string
  agentProfileId?: string
  /** From the session's Dispatch, when it has one; a coordinator's from its Run (no Task). */
  jobId?: string
  runId?: string
  taskId?: string
  source: AuditSource
  /** The provider's own name for the tool (`Bash`, `apply_patch`, `mcp__github__create_issue`). */
  providerTool: string
  action: AuditAction
  target: string
  insideProject?: boolean
  /** The resolver's commands of a compound line, each with its own place, so the rules judge it later as they would
   *  have then. At most AUDIT_COMMANDS_KEPT (recorder.ts); a line cut short is kept as `unknown`. */
  commands?: CommandFacts[]
  confidence: Confidence
  /** `blocked`: Enforce's hook stopped it before it ran (enforce design §5). */
  status: 'ok' | 'failed' | 'unknown' | 'blocked'
  /** What stopped a blocked call: a rule's id, `otherwise`, a built-in rule's id (`builtin-profile-write`,
   *  `builtin-settings-command`) or `fail-closed`. */
  blockedBy?: string
}

/** One use of a credential that passed through Astera (credentials design §6): a shared MCP server's stored secret through
 *  the Gateway, or a GitHub operation an agent asked Astera for or Astera made itself. Never a value, never a message. */
export interface CredentialUse {
  /** `cu_` + random. */
  id: string
  /** When it happened, ISO. */
  at: string
  /** Who asked: an Astera session (from its Gateway token, or `ASTERA_SESSION` for a command), Astera's MCP server (which
   *  carries no session today), the app, the Host's own automation, a paired controller, or a caller Astera did not start. */
  actor: 'session' | 'mcp' | 'app' | 'host' | 'controller' | 'outside'
  sessionId?: string
  runId?: string
  jobId?: string
  taskId?: string
  agentProfileId?: string
  /** The Credentials list's entry (`mcp:<serverId>`); absent for a login Astera does not manage (gh, git). */
  entryId?: string
  provider: 'mcp' | 'github'
  action: 'mcp.call' | 'github.read' | 'github.pr.create' | 'github.ci.rerun' | 'github.write' | 'git.remote.write'
  /** `<server>/<tool>`, or `owner/repo` with `#123` or a run id. */
  resource: string
  outcome: 'ok' | 'failed'
  /** `managed`: a stored secret reached the tool through Astera; `observed`: Astera ran it with a login it does not manage. */
  evidence: 'managed' | 'observed'
  requestId: string
}

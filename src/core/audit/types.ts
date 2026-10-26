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
export type AuditMode = 'compatibility' | 'observe'

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

export type AuditDecision = 'allow' | 'would-deny' | 'unknown'

export type CoverageClass = 'shell' | 'file-read' | 'file-write' | 'mcp' | 'network'

/** Why a class is only partly seen, as a key the screens and the CLI put in words. */
export type CoverageNote = 'web-tools-only' | 'shell-text-only' | 'web-search-and-shell-text'

export interface CoverageCell {
  level: 'seen' | 'partial' | 'none'
  note?: CoverageNote
}

export interface CoverageRow {
  provider: 'claude' | 'codex'
  kind: 'terminal' | 'chat'
  classes: Record<CoverageClass, CoverageCell>
}

/** Where a record came from (design §5). The provider is the first word. */
export type AuditSource = 'claude-hook' | 'claude-chat' | 'codex-rollout' | 'codex-chat'

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
  status: 'ok' | 'failed' | 'unknown'
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

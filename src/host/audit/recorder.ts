// Observe mode's recorder (design §5, §8): every source hands the Host's one recorder a tool call after it finished (the
// Claude hook, the Claude chat stream, the Codex rollout, the Codex chat items). While the mode is observe it names the
// call's action with the resolver, stamps it with the session's account and agent profile and its Dispatch's Job, Run
// and Task, and appends it to the record store. In compatibility it drops every call where it is handed over, touching
// nothing.
//
// The mode is read from audit-policy.json, not at every call: a read stands a few seconds, and the policies' commands
// say at once when they change it (`invalidate`). Calls are taken one after another and never make a source wait or
// fail: `record` returns at once, and whatever goes wrong behind it is logged and costs that call.
import { randomBytes } from 'node:crypto'
import { redactTarget, resolveAction, type ResolveCall, type ResolvedAction } from '../../core/audit/resolve'
import { appendRecords, type AuditRecord, type AuditSource } from '../../core/audit/store'
import type { AuditMode } from '../../core/audit/policy'
import type { OrchState } from '../../core/orchestration/state'
import type { PtyEntry } from '../../core/host/protocol'
import { agentProfileIdOf } from '../../core/sessions/noteInfo'

/** The commands of a line a record keeps. The resolver's are without repeats already; a line with more is cut and kept
 *  as `unknown`, since the rules cannot judge what was cut. */
export const AUDIT_COMMANDS_KEPT = 16
/** How long a read of the mode stands. */
const MODE_FRESH_MS = 5_000
/** Dedupe keys kept per session, and sessions kept; past either, the least recently heard go first. */
const KEYS_PER_SESSION = 1000
const SESSIONS_KEPT = 200
const TOOL_MAX = 100

/** Whose tool names a source's calls carry. */
const PROVIDER: Record<AuditSource, AuditRecord['provider']> = {
  'claude-hook': 'claude',
  'claude-chat': 'claude',
  'codex-rollout': 'codex',
  'codex-chat': 'codex'
}

/** What the recorder needs of a session Astera started: its note's facts. */
export interface SessionFacts {
  kind: 'terminal' | 'chat'
  accountId: string
  agentProfileId?: string
  /** What "inside the project" is measured against. */
  cwd: string
}

export interface DispatchIds {
  jobId?: string
  runId?: string
  taskId?: string
}

/** One finished tool call, as a source hands it over. */
export interface AuditEvent {
  /** The app's id for the session (ASTERA_SESSION). */
  sessionId: string
  source: AuditSource
  /** The provider's name for the tool. */
  tool: string
  /** The tool's input as the provider wrote it (resolve.ts `ResolveCall.input`): read to name the action, never kept. */
  input: unknown
  status: AuditRecord['status']
  /** The provider's id for the call (Claude's `tool_use_id`, Codex's call id): a call heard twice in a session is kept
   *  once. */
  dedupeKey?: string
  /** When the call happened, when the source knows (a hook line read after a restart); else when it is recorded. */
  at?: string
}

export interface AuditRecorder {
  /** Hands a finished call over. Returns at once and never throws. */
  record(ev: AuditEvent): void
  /** The mode may have changed: the next call reads it again. */
  invalidate(): void
  /** Settles once every call handed over so far is written or dropped. */
  flushed(): Promise<void>
}

export function createAuditRecorder(d: {
  profileDir: string
  /** The mode sessions are observed in (policy.ts `readPolicyMode`). */
  mode(): Promise<AuditMode>
  /** The session's facts, or null for one Astera did not start, which is not observed (design §5). */
  sessionInfo(sessionId: string): SessionFacts | null
  /** The Job, Run and Task of the session's Dispatch, or null when it has none. */
  dispatchOf(sessionId: string): DispatchIds | null
  log(message: string): void
  /** Test injection (epoch ms). */
  now?: () => number
  /** Test injection; defaults to the resolver. */
  resolve?: (call: ResolveCall) => ResolvedAction
}): AuditRecorder {
  const now = d.now ?? Date.now
  const resolve = d.resolve ?? resolveAction
  let mode: { value: AuditMode; readAt: number } | null = null
  /** Bumped by `invalidate`, so a read that began before it does not stand after it. */
  let generation = 0
  let queue: Promise<void> = Promise.resolve()
  const heardKeys = new Map<string, Set<string>>()

  const freshMode = (): AuditMode | null => (mode !== null && now() - mode.readAt < MODE_FRESH_MS ? mode.value : null)
  const currentMode = async (): Promise<AuditMode> => {
    const known = freshMode()
    if (known !== null) return known
    const g = generation
    const value = await d.mode()
    if (g === generation) mode = { value, readAt: now() }
    return value
  }

  /** Whether the call was heard before in its session; remembered if not. */
  const heard = (sessionId: string, key: string): boolean => {
    const keys = heardKeys.get(sessionId) ?? new Set<string>()
    // Moved to the end: the least recently heard session is the first to go
    heardKeys.delete(sessionId)
    heardKeys.set(sessionId, keys)
    if (heardKeys.size > SESSIONS_KEPT) heardKeys.delete(heardKeys.keys().next().value as string)
    if (keys.has(key)) return true
    keys.add(key)
    if (keys.size > KEYS_PER_SESSION) keys.delete(keys.values().next().value as string)
    return false
  }

  const timeOf = (at: string | undefined): string =>
    new Date(at !== undefined && Number.isFinite(Date.parse(at)) ? Date.parse(at) : now()).toISOString()

  const take = async (ev: AuditEvent): Promise<void> => {
    if ((await currentMode()) !== 'observe') return
    if (ev.dedupeKey !== undefined && heard(ev.sessionId, ev.dedupeKey)) return
    const info = d.sessionInfo(ev.sessionId)
    if (info === null) return
    const provider = PROVIDER[ev.source]
    const r = resolve({ provider, tool: ev.tool, input: ev.input, cwd: info.cwd })
    const ids = d.dispatchOf(ev.sessionId)
    const cut = r.commands !== undefined && r.commands.length > AUDIT_COMMANDS_KEPT
    const record: AuditRecord = {
      id: `au_${randomBytes(8).toString('hex')}`,
      at: timeOf(ev.at),
      sessionId: ev.sessionId,
      provider,
      kind: info.kind,
      accountId: info.accountId,
      ...(info.agentProfileId !== undefined ? { agentProfileId: info.agentProfileId } : {}),
      ...(ids?.jobId !== undefined ? { jobId: ids.jobId } : {}),
      ...(ids?.runId !== undefined ? { runId: ids.runId } : {}),
      ...(ids?.taskId !== undefined ? { taskId: ids.taskId } : {}),
      source: ev.source,
      providerTool: redactTarget(ev.tool).slice(0, TOOL_MAX),
      action: r.action,
      target: r.target,
      ...(r.insideProject !== undefined ? { insideProject: r.insideProject } : {}),
      ...(r.commands !== undefined ? { commands: r.commands.slice(0, AUDIT_COMMANDS_KEPT) } : {}),
      confidence: cut ? 'unknown' : r.confidence,
      status: ev.status
    }
    await appendRecords(d.profileDir, [record], { log: d.log })
  }

  return {
    record(ev) {
      // A mode known to be off drops the call here
      const known = freshMode()
      if (known !== null && known !== 'observe') return
      queue = queue.then(() => take(ev)).catch((err) => d.log(`audit: a ${ev.source} call of session ${ev.sessionId} was not recorded: ${String(err)}`))
    },
    invalidate() {
      mode = null
      generation++
    },
    flushed: () => queue
  }
}

/** `sessionInfo` over the Host's two registries: a terminal session's pty note, a chat session's process note, read the
 *  way `sessions list` reads them (sessions.ts). The live one when an ended one shares the id (a roll), and null for a
 *  plain shell tab, a run configuration or a note without its account or folder. */
export function registrySessionFacts(d: { ptys: { list(): PtyEntry[] }; procs: { list(): PtyEntry[] } }): (sessionId: string) => SessionFacts | null {
  const liveOrLast = (all: PtyEntry[]): PtyEntry | undefined => [...all].reverse().find((e) => e.alive) ?? all[all.length - 1]
  return (id) => {
    const terminal = liveOrLast(d.ptys.list().filter((e) => e.meta?.kind === 'session' && e.meta.id === id))
    const e = terminal ?? liveOrLast(d.procs.list().filter((e) => e.meta?.kind === 'chat' && e.meta.id === id))
    if (!e) return null
    const restore = e.meta!.restore
    const text = (k: string): string | null => (typeof restore[k] === 'string' && restore[k] !== '' ? (restore[k] as string) : null)
    const accountId = text('accountId')
    const cwd = text('cwd')
    if (accountId === null || cwd === null) return null
    const agentProfileId = agentProfileIdOf(restore)
    return { kind: terminal ? 'terminal' : 'chat', accountId, ...(agentProfileId !== undefined ? { agentProfileId } : {}), cwd }
  }
}

/** `dispatchOf` over the orchestration state: the session's open Dispatch, else its latest, and that Dispatch's Task, Run
 *  and Job, as far as they are still there. */
export function dispatchOfSession(s: OrchState, sessionId: string): DispatchIds | null {
  const held = s.dispatches.filter((x) => x.sessionId === sessionId)
  if (held.length === 0) return null
  const dispatch = held.find((x) => !x.endedAt) ?? held.reduce((a, b) => (b.startedAt >= a.startedAt ? b : a))
  const runId = s.tasks.find((t) => t.id === dispatch.taskId)?.runId
  const jobId = runId !== undefined ? s.runs.find((r) => r.id === runId)?.jobId : undefined
  return { ...(jobId !== undefined ? { jobId } : {}), ...(runId !== undefined ? { runId } : {}), taskId: dispatch.taskId }
}

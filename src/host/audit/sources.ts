// Observe mode's sources (design §5): where the Host hears the tool calls a session finished, read from what each
// provider already writes, and handed to the recorder (recorder.ts) one call at a time. Nothing here waits on a session
// and nothing is written back to one.
//
// - Claude terminal: the PostToolUse and PostToolUseFailure lines an observed session's audit capture appends to
//   hook-events/<session>.audit.jsonl (statusline.ts ensureObserveFiles), beside the session's own file, which the
//   other readers keep to. A watcher of these files alone (HookEventWatcher `audit`) is this module's, started at the
//   end of every file already there.
// - Claude and Codex chat: the lines of the chat process, which the Host holds for every chat it carries (procRegistry.ts),
//   whether the app or the Host decodes them. A Claude tool_use is handed over once its tool_result says how it went;
//   a Codex item once it is completed.
// - Codex terminal: the rollout the pty note names (`rolloutPath`, noted by whichever process found it), read forward
//   from the session's start. Its function_call and custom_tool_call lines are the calls (an `exec` script is handed
//   over whole, the resolver reads it), with mcp_tool_call_end, patch_apply_end and web_search_call from versions that
//   write those. Its item_completed lines repeat an exec's inner calls and are not read, or a call would count twice.
//   A shell, apply_patch or exec call is held until its output line says how it went (exit code, Script completed or
//   failed, Success.); one whose output has not come within a minute (CALL_WAIT_MS), or before its session, its file
//   (Codex's /new, read once more first) or the Host ends, is handed over as unknown, and an output after that adds
//   nothing.
//
// - Uses of shared skills, commands and agents (lifecycle design §4.12), handed to the recorder's `use`: from a Claude
//   terminal's audit file, a Skill or Agent call that ran, a person's `/name` (UserPromptExpansion) and an agent's start
//   (SubagentStart, once per agent); from a Claude chat's stream, a Skill or Agent call that ran. Only the name each
//   reported. And two marks, handed until the recorder says each was written, and again each local day the session runs,
//   so neither ages out of the 30 days: a Claude chat ran, from the first line of its stream read while observing (ruling
//   R6-1), since a skill or command typed into a chat is expanded with no call and no hook; and a Claude terminal session
//   ran without the use hooks (its note's `useHooks` is not true, ruling R6-8), found in the Host's own list of live
//   sessions, so one that sends nothing is marked too. Codex reports no use exactly, so none is read from it.
//
// - Enforce (enforce design §5): a call the blocking hook stopped never ran, so none of the above hears it. The hook
//   writes every call it sees to enforce/<session>.jsonl, a stopped one with its rule and what it resolved the call to;
//   that file is read for each session whose note says it was started in Enforce, at every poll and, synchronously,
//   before any of the session's other calls is handed over, so a call the provider reports after the hook stopped it
//   (a Claude chat's tool_result) is kept once, as blocked.
//
// Only sessions whose note says they were started observed are followed (Review Focus 1); the recorder asks the same
// of a hook line. The Host reads only what it holds: a session the app runs in its own node-pty, with no Host, is not
// observed (design §8, no second recorder in the app). While the recorder knows the mode is compatibility nothing is
// read: the audit watcher is stopped, the rollouts are not read and the chat lines are not parsed; when it may be
// observe again, the audit files and the rollouts are taken up from where they end then (the recorder tells the sources
// at the switch, not at their next poll), so nothing done while the mode was off is recorded and nothing done after
// it is missed.
//
// Restarts (Review Focus 3): the audit watcher starts every file already there at its end, and a Host's sessions end
// with it (its ptys and chat processes are its children), so a new Host has no earlier line of a live session to read
// again. Within one Host, a call heard twice is kept once by the recorder's dedupe on the provider's call id. What a
// Host does not hear while it is down is lost: the app empties hook-events at its next start.
import { closeSync, fstatSync, openSync, readSync, promises as fsp, type watch } from 'node:fs'
import path from 'node:path'
import { AUDIT_ACTIONS } from '../../core/audit/policy'
import { SENSITIVE_NAMES } from '../../core/audit/sensitive'
import { CALL_EFFECTS, type AuditAction, type CallEffect } from '../../core/audit/types'
import { decodeClaudeFrame } from '../../core/chat/claudeProtocol'
import { decodeFrame } from '../../core/chat/codexProtocol'
import { outputText } from '../../core/history/codexConversation'
import { HOOK_EVENT_AT } from '../../core/hooks/eventTime'
import { HookEventWatcher } from '../../core/hooks/eventWatcher'
import { JsonlTail } from '../../core/rolling/jsonlTail'
import { auditDayOf, type AuditSource } from '../../core/audit/store'
import type { PtyEntry, PtyMeta } from '../../core/host/protocol'
import type { AuditEvent, AuditRecorder, UseEvent } from './recorder'

/** One finished call as a source reads it, before it is told whose session it was. `stoppedByHook`: a Codex call whose
 *  output says a PreToolUse hook stopped its one command (`hookStopped`), which in a session started in Enforce is the
 *  enforce file's to record. */
export type ObservedCall = Omit<AuditEvent, 'sessionId' | 'source'> & { stoppedByHook?: true }

/** How often the rollouts are read forward: the rollout watcher's own period. */
export const ROLLOUT_POLL_MS = 1_000
/** Claude chat calls that wait for their result, per session, at most; past it the oldest is let go. */
const PENDING_MAX = 200
/** Claude terminal sessions whose shell's place is kept, at most; past it the one heard least recently is let go. */
const SHELLS_KEPT = 200
/** Agent ids kept per session, and sessions kept, for SubagentStart: as the recorder keeps its dedupe keys. */
const AGENTS_PER_SESSION = 1000
const AGENT_SESSIONS_KEPT = 200

/** A use as a source reads it, before it is told whose session it was (recorder.ts UseEvent). */
export type HeardUse = Omit<UseEvent, 'sessionId' | 'source'>

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
/** An epoch time in milliseconds as ISO, or undefined for anything that is not one. */
const isoOf = (ms: unknown): string | undefined =>
  typeof ms === 'number' && Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : undefined

/** The header lines of a patch envelope naming `paths`, which is all the resolver reads of a patch (resolve.ts
 *  patchPaths): a change's contents are never handed over. */
const patchNaming = (paths: string[]): string => paths.map((p) => `*** Update File: ${p}`).join('\n')

// ---------------------------------------------------------------------------------------------------------------------
// Claude hook

/** An audit line as one call, run in `ranIn` when the caller knows where. Claude Code fires PostToolUse once a tool has
 *  run and PostToolUseFailure, instead, once it failed or was interrupted (`is_interrupt`), so the event is the outcome;
 *  the capture keeps no output to read one from. null for any other event. */
export function hookCall(payload: unknown, ranIn?: string): ObservedCall | null {
  const p = obj(payload)
  const status = p?.hook_event_name === 'PostToolUse' ? 'ok' : p?.hook_event_name === 'PostToolUseFailure' ? 'failed' : null
  const tool = str(p?.tool_name)
  if (!p || status === null || tool === null) return null
  const id = str(p.tool_use_id)
  const at = isoOf(p[HOOK_EVENT_AT])
  return {
    tool,
    input: p.tool_input,
    status,
    ...(id !== null ? { dedupeKey: id } : {}),
    ...(at !== undefined ? { at } : {}),
    ...(ranIn !== undefined ? { cwd: ranIn } : {})
  }
}

/**
 * A reader of the uses in one Host's Claude audit lines (lifecycle design §4.12, research cli-use-reporting.md §1): a
 * Skill call that ran (PostToolUse, by its `skill`; a failure is an unknown skill or a call that was stopped), a skill or
 * command a person typed (UserPromptExpansion of a `slash_command`, by its `command_name`; an `mcp_prompt` is an MCP
 * server's prompt), and an agent's start (SubagentStart, by its `agent_type`). Claude Code fires SubagentStart again when
 * an agent is resumed and for each message a teammate takes up, so each `agent_id` is handed once per session, the ids
 * kept as the recorder keeps its keys. A name is handed as reported, a plugin's `p:name` included: the findings match it.
 */
export function claudeHookUses(): (sessionId: string, payload: unknown) => HeardUse | null {
  const agents = new Map<string, Set<string>>()
  /** Whether the agent was handed before in its session; remembered if not. */
  const handed = (sessionId: string, agentId: string): boolean => {
    const ids = agents.get(sessionId) ?? new Set<string>()
    // Moved to the end: the least recently heard session is the first to go
    agents.delete(sessionId)
    agents.set(sessionId, ids)
    if (agents.size > AGENT_SESSIONS_KEPT) agents.delete(agents.keys().next().value as string)
    if (ids.has(agentId)) return true
    ids.add(agentId)
    if (ids.size > AGENTS_PER_SESSION) ids.delete(ids.values().next().value as string)
    return false
  }
  return (sessionId, payload) => {
    const p = obj(payload)
    if (!p) return null
    const at = isoOf(p[HOOK_EVENT_AT])
    const heard = (via: HeardUse['via'], name: string | null, dedupeKey?: string | null): HeardUse | null =>
      name === null ? null : { via, name, ...(dedupeKey ? { dedupeKey } : {}), ...(at !== undefined ? { at } : {}) }
    switch (p.hook_event_name) {
      case 'PostToolUse':
        // An Agent call names the agent it started too (Task, by its older name): with or without a SubagentStart, a use
        if (p.tool_name === 'Agent' || p.tool_name === 'Task') return heard('agent-tool', str(obj(p.tool_input)?.subagent_type), str(p.tool_use_id))
        return p.tool_name === 'Skill' ? heard('skill-tool', str(obj(p.tool_input)?.skill), str(p.tool_use_id)) : null
      case 'UserPromptExpansion':
        return p.expansion_type === 'slash_command' ? heard('slash', str(p.command_name)) : null
      case 'SubagentStart': {
        const agentId = str(p.agent_id)
        if (agentId !== null && handed(sessionId, agentId)) return null
        return heard('subagent', str(p.agent_type))
      }
      default:
        return null
    }
  }
}

/** The use a Claude chat's call made (§4.12): a Skill call that ran, by its `skill`, or an Agent call (Task, by its older
 *  name) that ran, by its `subagent_type`, which Claude Code matches to an agent's name whatever its case or separators.
 *  The rest of the input (a Skill's `args`, an agent's prompt) is never handed. */
export function claudeChatUse(c: ObservedCall): HeardUse | null {
  if (c.status !== 'ok') return null
  const input = obj(c.input)
  const named = (via: HeardUse['via'], name: string | null): HeardUse | null =>
    name === null ? null : { via, name, ...(c.dedupeKey !== undefined ? { dedupeKey: c.dedupeKey } : {}), ...(c.at !== undefined ? { at: c.at } : {}) }
  if (c.tool === 'Skill') return named('skill-tool', str(input?.skill))
  if (c.tool === 'Agent' || c.tool === 'Task') return named('agent-tool', str(input?.subagent_type))
  return null
}

/** Where an audit line's call left Claude's shell: the hook's `cwd`, which Claude Code reads when the hook fires, after
 *  a `cd` in the line (and after its own reset to the project, in a version that resets). Claude's shell keeps its
 *  directory from call to call, so this is where the session's next call runs. */
export const hookShellAfter = (payload: unknown): string | null => str(obj(payload)?.cwd)

// ---------------------------------------------------------------------------------------------------------------------
// Claude chat

/**
 * A reader of one Claude chat's stream-json lines. An assistant frame's tool_use is held until the user frame with its
 * tool_result: then it is one call, failed when the result is an error. A result the CLI marks as not run (a call the
 * person declined, `tool_result_meta[].non_execution_kind`) is not a call, as a declined call fires no PostToolUse in
 * a terminal session. At most PENDING_MAX calls wait per session.
 */
export function claudeChatCalls(): (line: string) => ObservedCall[] {
  const pending = new Map<string, { tool: string; input: unknown }>()
  return (line) => {
    if (!line.includes('"tool_')) return []
    const f = decodeClaudeFrame(line)
    if (f?.kind !== 'message' || (f.type !== 'assistant' && f.type !== 'user')) return []
    const content = obj(f.body.message)?.content
    const blocks = (Array.isArray(content) ? content : []).map(obj).filter((b): b is Record<string, unknown> => b !== null)
    if (f.type === 'assistant') {
      for (const b of blocks) {
        const id = str(b.id)
        const tool = str(b.name)
        if (b.type !== 'tool_use' || id === null || tool === null) continue
        pending.delete(id)
        pending.set(id, { tool, input: b.input })
        if (pending.size > PENDING_MAX) pending.delete(pending.keys().next().value as string)
      }
      return []
    }
    const meta = f.body.tool_result_meta
    const notRun = new Set(
      (Array.isArray(meta) ? meta : []).map(obj).flatMap((m) => (m && str(m.id) !== null && str(m.non_execution_kind) !== null ? [m.id as string] : []))
    )
    const out: ObservedCall[] = []
    for (const b of blocks) {
      const id = str(b.tool_use_id)
      if (b.type !== 'tool_result' || id === null) continue
      const call = pending.get(id)
      pending.delete(id)
      if (!call || notRun.has(id)) continue
      out.push({ tool: call.tool, input: call.input, status: b.is_error === true ? 'failed' : 'ok', dedupeKey: id })
    }
    return out
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Codex chat

/**
 * A Codex app-server line as one call, when it is an `item/completed` of a command, a file change or an MCP call that
 * ran (completed or failed), a web search, a file view or an agent spawn. A declined item did not run, and is not a
 * call. The command line goes to the resolver as a Codex shell call's would; a file change as the files it names; a
 * search and a spawn with nothing of what they carried (the query, the prompt).
 */
export function codexChatCall(line: string): ObservedCall | null {
  if (!line.includes('item/completed')) return null
  const f = decodeFrame(line)
  if (f?.kind !== 'notification' || f.method !== 'item/completed') return null
  const params = obj(f.params)
  const item = obj(params?.item)
  const id = str(item?.id)
  if (!item || id === null) return null
  const at = isoOf(params?.completedAtMs)
  const call = (tool: string, input: unknown, status: ObservedCall['status']): ObservedCall => ({
    tool,
    input,
    status,
    dedupeKey: id,
    ...(at !== undefined ? { at } : {})
  })
  // Items with no status of their own: completed is done
  if (item.type === 'webSearch') return call('web_search', {}, 'ok')
  if (item.type === 'imageView') return call('view_image', { path: item.path }, 'ok')
  if (item.type === 'collabAgentToolCall')
    return item.tool === 'spawnAgent'
      ? call('spawn_agent', {}, item.status === 'completed' ? 'ok' : item.status === 'failed' ? 'failed' : 'unknown')
      : null
  const status = item.status === 'completed' ? 'ok' : item.status === 'failed' ? 'failed' : null
  if (status === null) return null
  switch (item.type) {
    case 'commandExecution': {
      const workdir = str(item.cwd)
      return call('shell', { command: item.command, ...(workdir !== null ? { workdir } : {}) }, status)
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : []
      return call('apply_patch', patchNaming(changes.map((c) => str(obj(c)?.path)).filter((p): p is string => p !== null)), status)
    }
    case 'mcpToolCall': {
      const server = str(item.server)
      const tool = str(item.tool)
      return server !== null && tool !== null ? call(`mcp__${server}__${tool}`, {}, status) : null
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Codex rollout

/** The rollout lines that can be a call, told apart before a line is parsed. */
const ROLLOUT_CALL = /"(?:function_call|custom_tool_call|mcp_tool_call_end|patch_apply_end|web_search_call)"/
/** The lines that end a call, told apart the same way. */
const ROLLOUT_OUTPUT = /"(?:function_call_output|custom_tool_call_output)"/
/** Calls waiting for their output, per rollout, at most; past it the oldest is handed over as unknown. */
const WAITING_MAX = 200
/** How long a call waits for its output, from when it was read; past it, it is handed over as unknown, so a Host that
 *  ends first loses at most this much, and its output, should it come later, adds nothing. */
export const CALL_WAIT_MS = 60_000

/** What reads a tool's output for how it went: a command's exit code, an exec script's opening, an apply_patch's result.
 *  Other tools (agents, goals, searches) have an output that says nothing of the sort, so their call is handed at once.
 *  A Map, so a tool named `constructor` or `toString` finds nothing, not an object's own function. */
const OUTCOME_OF = new Map<string, 'shell' | 'exec' | 'patch'>([
  ['shell', 'shell'], ['shell_command', 'shell'], ['exec_command', 'shell'], ['local_shell', 'shell'], ['container.exec', 'shell'],
  ['exec', 'exec'], ['apply_patch', 'patch']
])

/** The exit code a command's output opens with: "Exit code: N" or "Process exited with code N" before the `Output:`
 *  line (what the command printed is never read), or the `metadata.exit_code` of the JSON older Codex wrote. */
function exitCodeOf(text: string): number | null {
  if (text.startsWith('{')) {
    try {
      const code = obj(obj(JSON.parse(text))?.metadata)?.exit_code
      return typeof code === 'number' ? code : null
    } catch {
      return null
    }
  }
  const at = text.indexOf('\nOutput:')
  const head = at < 0 ? text : text.slice(0, at)
  const m = /^(?:Exit code:|Process exited with code)\s*(-?\d+)/m.exec(head)
  return m ? Number(m[1]) : null
}

/** A completed exec script's calls, from the JSON it printed after its header: codex 0.160 runs a command inside the
 *  script, which completes even when the command fails, so each call's own `exit_code` (and a rejected call) decides.
 *  What a command printed is a string inside that JSON, its quotes escaped, so an `"exit_code"` in it is never read.
 *  No code at all: a script that ran a command printed only its text (`text(r.output)`), or left it running in the
 *  background, so how the command went is unknown; a script of MCP calls alone, which fails when one is refused, is ok. */
function execResults(rest: string, runsCommand: boolean): ObservedCall['status'] {
  let codes = 0
  for (const m of rest.matchAll(/(?<!\\)"exit_code":\s*(-?\d+)/g)) {
    if (Number(m[1]) !== 0) return 'failed'
    codes++
  }
  if (/(?<!\\)"status":\s*"rejected"/.test(rest)) return 'failed'
  if (codes > 0) return 'ok'
  return runsCommand || /(?<!\\)"session_id":/.test(rest) ? 'unknown' : 'ok'
}

/** Whether an exec script runs a command: one of Codex's shell tools called from it. */
const EXEC_RUNS_COMMAND = /\btools\.(?:exec_command|shell_command|shell|local_shell)\s*\(/

/** Codex's words when Astera's PreToolUse hook refused an exec script's call, at the start of its output (codex 0.160,
 *  measured 2026-10-27: "Script failed …" then "Script error:\nCommand blocked by PreToolUse hook: <reason>"), and Astera's
 *  own reasons start "Blocked by Astera": another hook's refusal, or a command that printed the words, is not it (final
 *  review M3). A shell call's output says it near its start. */
const EXEC_STOPPED = /^Script failed[^\n]*\n[\s\S]*?Script error:\s*Command blocked by PreToolUse hook: Blocked by Astera/
const SHELL_STOPPED = /^[\s\S]{0,200}?Command blocked by PreToolUse hook: Blocked by Astera/
/** Whether a call's output says Astera's hook stopped it, and it was one call: a shell command, or an exec script that
 *  calls one tool (Codex's code mode, whose inner call the hook sees under an id of its own). A script of several calls
 *  ran the others, and stays the record of them. */
function hookStopped(kind: 'shell' | 'exec' | 'patch', text: string | null, input: unknown): boolean {
  if (text === null || !(kind === 'exec' ? EXEC_STOPPED : SHELL_STOPPED).test(text)) return false
  if (kind !== 'exec') return true
  return typeof input === 'string' && (input.match(/\btools\.[A-Za-z_][A-Za-z0-9_]*\s*\(/g) ?? []).length === 1
}

/** How a call went, from the text of its output (and for an exec script, the script it ran): ok, failed, or unknown
 *  when it says nothing (or the call goes on). */
function outcomeOf(kind: 'shell' | 'exec' | 'patch', text: string | null, input?: unknown): ObservedCall['status'] {
  if (text === null || text.trim() === '') return 'unknown'
  if (kind === 'exec') {
    const first = text.split('\n')[0].trim()
    if (first.startsWith('Script failed') || first.startsWith('aborted')) return 'failed'
    if (!first.startsWith('Script completed')) return 'unknown'
    return execResults(text.slice(first.length), typeof input === 'string' && EXEC_RUNS_COMMAND.test(input))
  }
  if (kind === 'patch') {
    if (text.startsWith('Success')) return 'ok'
    const code = exitCodeOf(text)
    if (code !== null) return code === 0 ? 'ok' : 'failed'
    // Only the signs known to mean a refusal count; any other wording says nothing about how it went
    return /^\s*(apply_patch verification failed|error\b|failed\b)/i.test(text) ? 'failed' : 'unknown'
  }
  const code = exitCodeOf(text)
  return code === null ? 'unknown' : code === 0 ? 'ok' : 'failed'
}

export interface RolloutReader {
  /** The calls finished by the lines read (rollout lines written at `since` or after; a line without its time is
   *  passed). A shell, apply_patch or exec call is held until its output line says how it went, in a later read too, up
   *  to `overdue`; an end event's own status stands for its call. */
  read(lines: readonly string[], since: number): ObservedCall[]
  /** The calls that have waited CALL_WAIT_MS for an output, as unknown, once. */
  overdue(): ObservedCall[]
  /** The calls still waiting for an output, as unknown, once: the session ended or the rollout is not read any more. */
  unfinished(): ObservedCall[]
  /** Lets go of what waits, handing nothing over: the lines in between were not read. */
  forget(): void
}

/** `now` (epoch ms) is when a call is read, for CALL_WAIT_MS. */
export function codexRolloutCalls(now: () => number = Date.now): RolloutReader {
  const waiting = new Map<string, { call: ObservedCall; kind: 'shell' | 'exec' | 'patch'; readAt: number }>()
  return {
    read(lines, since) {
      const out: ObservedCall[] = []
      for (const line of lines) {
        const isOutput = ROLLOUT_OUTPUT.test(line)
        if (isOutput ? waiting.size === 0 : !ROLLOUT_CALL.test(line)) continue
        let o: Record<string, unknown> | null
        try {
          o = obj(JSON.parse(line))
        } catch {
          continue
        }
        const p = obj(o?.payload)
        if (!p) continue
        if (isOutput) {
          const id = str(p.call_id)
          const held = id === null ? undefined : waiting.get(id)
          if (!held) continue
          waiting.delete(id!)
          const text = outputText(p.output)
          out.push({
            ...held.call,
            status: outcomeOf(held.kind, text, held.call.input),
            ...(hookStopped(held.kind, text, held.call.input) ? { stoppedByHook: true as const } : {})
          })
          continue
        }
        const t = Date.parse(str(o?.timestamp) ?? '')
        if (!(t >= since)) continue
        const call = rolloutCall(o!.type, p)
        if (!call) continue
        const stamped = { ...call, at: new Date(t).toISOString() }
        const kind = call.status === 'unknown' && call.dedupeKey !== undefined ? OUTCOME_OF.get(call.tool) : undefined
        if (!kind) {
          // An end event stands for the call it ends
          if (call.dedupeKey !== undefined) waiting.delete(call.dedupeKey)
          out.push(stamped)
          continue
        }
        waiting.delete(call.dedupeKey!)
        waiting.set(call.dedupeKey!, { call: stamped, kind, readAt: now() })
        if (waiting.size > WAITING_MAX) {
          const [oldest] = waiting
          waiting.delete(oldest[0])
          out.push(oldest[1].call)
        }
      }
      return out
    },
    overdue() {
      const out: ObservedCall[] = []
      // In the order they were read, so the first that has not waited long enough ends the look
      for (const [id, w] of waiting) {
        if (now() - w.readAt < CALL_WAIT_MS) break
        waiting.delete(id)
        out.push(w.call)
      }
      return out
    },
    unfinished() {
      const left = [...waiting.values()].map((w) => w.call)
      waiting.clear()
      return left
    },
    forget: () => waiting.clear()
  }
}

function rolloutCall(type: unknown, p: Record<string, unknown>): ObservedCall | null {
  const key = (k: string): { dedupeKey?: string } => (str(p[k]) !== null ? { dedupeKey: p[k] as string } : {})
  if (type === 'response_item') {
    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      const tool = str(p.name)
      if (tool === null) return null
      return { tool, input: p.type === 'function_call' ? p.arguments : p.input, status: 'unknown', ...key('call_id') }
    }
    if (p.type === 'web_search_call')
      return { tool: 'web_search_call', input: {}, status: p.status === 'completed' ? 'ok' : p.status === 'failed' ? 'failed' : 'unknown', ...key('id') }
    return null
  }
  if (type !== 'event_msg') return null
  if (p.type === 'mcp_tool_call_end') {
    const inv = obj(p.invocation)
    const server = str(inv?.server)
    const tool = str(inv?.tool)
    if (server === null || tool === null) return null
    const result = obj(p.result)
    const status = !result ? 'unknown' : 'Err' in result || obj(result.Ok)?.isError === true ? 'failed' : 'Ok' in result ? 'ok' : 'unknown'
    return { tool: `mcp__${server}__${tool}`, input: {}, status, ...key('call_id') }
  }
  if (p.type === 'patch_apply_end') {
    const changes = obj(p.changes)
    const status = p.success === true ? 'ok' : p.success === false ? 'failed' : 'unknown'
    return { tool: 'apply_patch', input: patchNaming(changes ? Object.keys(changes) : []), status, ...key('call_id') }
  }
  return null
}

// ---------------------------------------------------------------------------------------------------------------------
// Enforce

const ACTION_NAMES = new Set<string>(AUDIT_ACTIONS)
const CONFIDENCES = new Set(['exact', 'high', 'heuristic', 'unknown'])
const EFFECTS = new Set<string>(CALL_EFFECTS)
/** How much of an enforce file one read takes at most; the rest is read at the next. */
const ENFORCE_READ_MAX = 1 << 20
/** Call ids of a session's file kept for the proof; a call's report comes seconds after its hook's line. */
const ENFORCE_IDS_KEPT = 5000
/** Claude's tools no hook may see: its hosted web search. */
const UNHOOKED_CLAUDE_TOOLS = new Set(['WebSearch'])

/** A hook line's call id, blocked or not. */
function lineId(line: string): string | null {
  try {
    return str(obj(JSON.parse(line))?.id)
  } catch {
    return null
  }
}

/** A line of a session's enforce file as the call the hook stopped, with whose CLI it was; null for a call it let
 *  through, and for anything that is not a line the hook writes. */
export function enforceBlockedCall(line: string): (ObservedCall & { provider: 'claude' | 'codex' }) | null {
  let o: Record<string, unknown> | null
  try {
    o = obj(JSON.parse(line))
  } catch {
    return null
  }
  const blockedBy = str(o?.blocked)
  const tool = str(o?.tool)
  const action = str(o?.action)
  if (!o || blockedBy === null || tool === null || action === null || !ACTION_NAMES.has(action)) return null
  const target = typeof o.target === 'string' ? o.target : ''
  const confidence = CONFIDENCES.has(o.confidence as string) ? (o.confidence as 'exact' | 'high' | 'heuristic' | 'unknown') : 'unknown'
  const id = str(o.id)
  const at = isoOf(o.at)
  return {
    provider: o.provider === 'codex' ? 'codex' : 'claude',
    tool,
    input: {},
    status: 'blocked',
    blockedBy,
    ...(id !== null ? { dedupeKey: id } : {}),
    ...(at !== undefined ? { at } : {}),
    resolved: {
      action: action as AuditAction,
      target,
      confidence,
      ...(typeof o.insideProject === 'boolean' ? { insideProject: o.insideProject } : {}),
      // Lifecycle design §4.10. Only a value the hook can write is kept, so no path reaches a record as a login folder's
      // name; a hook of an earlier release wrote neither
      ...(typeof o.effect === 'string' && EFFECTS.has(o.effect) ? { effect: o.effect as CallEffect } : {}),
      ...(typeof o.sensitive === 'string' && SENSITIVE_NAMES.has(o.sensitive) ? { sensitive: o.sensitive } : {})
    }
  }
}

/** One session's enforce file, read forward synchronously: the whole lines written since the last read. A file not
 *  there yet reads as nothing; one that got shorter is read from its start again. */
class EnforceFile {
  private offset = 0
  private rest: Buffer = Buffer.alloc(0)
  /** The ids of the calls it says were stopped, so the provider's own report of one is not handed over too. */
  readonly blocked = new Set<string>()
  /** The ids of every call the hook saw, the newest ENFORCE_IDS_KEPT: a Claude call that ran is among them (final review
   *  I4). */
  readonly seen = new Set<string>()
  /** Blocks not yet matched to a Codex report of one stopped call under another id (`stoppedByHook`). */
  unmatched = 0

  saw(id: string): void {
    this.seen.add(id)
    if (this.seen.size > ENFORCE_IDS_KEPT) this.seen.delete(this.seen.values().next().value as string)
  }
  constructor(readonly file: string) {}

  readNew(): string[] {
    let fd: number
    try {
      fd = openSync(this.file, 'r')
    } catch {
      return []
    }
    try {
      const size = fstatSync(fd).size
      if (size < this.offset) {
        this.offset = 0
        this.rest = Buffer.alloc(0)
      }
      if (size === this.offset) return []
      const buf = Buffer.alloc(Math.min(size - this.offset, ENFORCE_READ_MAX))
      const n = readSync(fd, buf, 0, buf.length, this.offset)
      this.offset += n
      const all = Buffer.concat([this.rest, buf.subarray(0, n)])
      const end = all.lastIndexOf(0x0a)
      this.rest = end < 0 ? all : all.subarray(end + 1)
      return end < 0 ? [] : all.subarray(0, end).toString('utf8').split('\n').filter((l) => l.trim() !== '')
    } finally {
      closeSync(fd)
    }
  }

}

/** Deletes the enforce file of every session not in `keep`: run at the Host's start, when no session of an earlier
 *  Host is alive, so the folder holds only the files of the sessions running now. Never rejects. */
export async function pruneEnforceFiles(enforceDir: string, keep: ReadonlySet<string>): Promise<void> {
  let names: string[]
  try {
    names = await fsp.readdir(enforceDir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl') || keep.has(name.slice(0, -'.jsonl'.length))) continue
    await fsp.rm(path.join(enforceDir, name), { force: true }).catch(() => {})
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The Host's wiring

type Listen<A extends unknown[]> = (cb: (...a: A) => void) => () => void

export interface AuditSources {
  /** Reads the audit files and every followed rollout forward once (the timer reads the rollouts; the audit files are
   *  watched). Never rejects. */
  poll(): Promise<void>
  dispose(): void
}

export function createAuditSources(d: {
  /** `retryMode` is asked at every tick of the timer: the recorder says when it is due. */
  recorder: Pick<AuditRecorder, 'record' | 'use' | 'observing' | 'onObservingChange'> & Partial<Pick<AuditRecorder, 'retryMode' | 'unhooked'>>
  /** `list`: the registry's entries, where the Claude terminal sessions without the use hooks are found (ruling R6-8).
   *  Without it none is marked. */
  ptys: { onMeta: Listen<[string, PtyMeta, 'open' | 'note']>; onExit: Listen<[string, number]>; list?: () => PtyEntry[] }
  procs: { onMeta: Listen<[string, PtyMeta, 'open' | 'note']>; onLine: Listen<[string, number, string]>; onExit: Listen<[string, number]> }
  /** Whether an account is Claude's, for an observed terminal note that does not say whether it got the use hooks (one an
   *  app that did not write the mark wrote): a Codex session has none. Unset: such a note is not marked. */
  claudeAccount?: (accountId: string) => Promise<boolean>
  /** The profile's hook-events folder, where the observed sessions' audit files are. */
  hookEventsDir: string
  /** The profile's enforce folder (profilePaths `enforceEvents`), where the Enforce hook writes each session's calls.
   *  Unset: no enforce file is read. */
  enforceDir?: string
  log(message: string): void
  /** Test injection (epoch ms). */
  now?: () => number
  /** Test injection: how the rollouts are read again; returns the stop. */
  every?: (ms: number, fn: () => void) => () => void
  /** Test injection: the audit watcher's folder watch. */
  watch?: typeof watch
}): AuditSources {
  const now = d.now ?? Date.now
  /** The local day now, the day a mark is written for. */
  const today = (): string => auditDayOf(new Date(now()).toISOString())

  /** A mark (a Claude chat that ran, a session without the use hooks) for one session: the local day it was last written
   *  for, and whether one is on its way. Handed when neither holds, and counted only once the recorder says it was
   *  written, so one the recorder let go is handed again. */
  type Mark = { day: string | null; handing: boolean }
  const handMark = (m: Mark, sessionId: string, source: Extract<AuditSource, 'claude-hook' | 'claude-chat'>, via: 'chat-seen' | 'unhooked'): void => {
    const day = today()
    if (m.handing || m.day === day) return
    m.handing = true
    d.recorder.use({ sessionId, source, via, name: '' }, (written) => {
      m.handing = false
      if (written) m.day = day
    })
  }

  /** The sessions started in Enforce, by session id, and which pty or process each runs in. */
  const enforcing = new Map<string, EnforceFile>()
  const enforcedBy = new Map<string, string>()
  const followEnforce = (holder: string, meta: PtyMeta): void => {
    if (!d.enforceDir || meta.restore.enforced !== true || enforcing.has(meta.id)) return
    enforcing.set(meta.id, new EnforceFile(path.join(d.enforceDir, `${meta.id}.jsonl`)))
    enforcedBy.set(holder, meta.id)
  }
  /** Hands over what the session's enforce file says was stopped since it was last read, in any mode: a session started
   *  in Enforce keeps blocking after the mode is turned off, and its blocks say why (final review I7). */
  const readEnforce = (sessionId: string): void => {
    const f = enforcing.get(sessionId)
    if (!f) return
    try {
      for (const line of f.readNew()) {
        const id = lineId(line)
        if (id !== null) f.saw(id)
        const c = enforceBlockedCall(line)
        if (!c) continue
        const { provider, ...call } = c
        if (call.dedupeKey !== undefined) f.blocked.add(call.dedupeKey)
        f.unmatched++
        d.recorder.record({ sessionId, source: provider === 'codex' ? 'codex-hook' : 'claude-hook', ...call })
      }
    } catch (err) {
      d.log(`audit: the enforce file of session ${sessionId} could not be read: ${String(err)}`)
    }
  }
  const unfollowEnforce = (holder: string): void => {
    const sessionId = enforcedBy.get(holder)
    if (sessionId === undefined) return
    // Read once more, for what it wrote last
    readEnforce(sessionId)
    enforcedBy.delete(holder)
    enforcing.delete(sessionId)
  }

  /** A session's finished calls, after what its enforce file says: a call the hook stopped is the file's, not these. */
  const hand = (sessionId: string, source: AuditSource, calls: ObservedCall[]): void => {
    const f = enforcing.get(sessionId)
    if (f) readEnforce(sessionId)
    for (const { stoppedByHook, ...c } of calls) {
      if (f && c.dedupeKey !== undefined && f.blocked.has(c.dedupeKey)) continue
      // Codex's report of the one call the hook stopped, under its own id: the file's blocked line is that call
      if (f && stoppedByHook && f.unmatched > 0) {
        f.unmatched--
        continue
      }
      // A Claude call that ran has its hook's line under the same tool_use_id; one without ran unhooked (final review I4)
      const ran = c.status === 'ok' || c.status === 'failed'
      if (f && ran && (source === 'claude-hook' || source === 'claude-chat') && c.dedupeKey !== undefined && !f.seen.has(c.dedupeKey) && !UNHOOKED_CLAUDE_TOOLS.has(c.tool))
        d.recorder.unhooked?.(sessionId)
      d.recorder.record({ sessionId, source, ...c })
    }
  }

  /** Where each observed Claude session's last call left its shell (hookShellAfter), so where its next call runs. Not
   *  known for a session's first call heard, which the resolver reads from the session's folder. */
  const shellAt = new Map<string, string>()
  const hookUses = claudeHookUses()
  const hooks = new HookEventWatcher(
    d.hookEventsDir,
    (sessionId, payload) => {
      if (!d.recorder.observing()) return
      try {
        const u = hookUses(sessionId, payload)
        if (u) d.recorder.use({ sessionId, source: 'claude-hook', ...u })
        const c = hookCall(payload, shellAt.get(sessionId))
        if (!c) return
        hand(sessionId, 'claude-hook', [c])
        const after = hookShellAfter(payload)
        // Moved to the end: the session heard least recently is the first to go
        shellAt.delete(sessionId)
        if (after !== null) shellAt.set(sessionId, after)
        if (shellAt.size > SHELLS_KEPT) shellAt.delete(shellAt.keys().next().value as string)
      } catch (err) {
        d.log(`audit: an audit line of session ${sessionId} could not be read: ${String(err)}`)
      }
    },
    d.log,
    undefined,
    { audit: true, startAtEnd: true, ...(d.watch ? { watch: d.watch } : {}) }
  )

  /** Observed chat processes, by proc id, with a Claude chat's mark (ruling R6-1). */
  const chats = new Map<string, { sessionId: string; source: AuditSource; read: (line: string) => ObservedCall[]; mark: Mark }>()
  /** Observed terminal sessions, by pty id: the rollout followed, once the note names one, and the files a newer one
   *  replaced (`left`), each read once more at the next poll with the calls it still waits for. */
  const rollouts = new Map<
    string,
    {
      sessionId: string
      since: number | null
      path: string | null
      tail: JsonlTail | null
      ended: boolean
      calls: RolloutReader
      left: Array<{ tail: JsonlTail; calls: RolloutReader }>
    }
  >()

  const offs = [
    d.procs.onMeta((procId, meta) => {
      if (meta.kind === 'chat') followEnforce(procId, meta)
      if (meta.kind !== 'chat' || meta.restore.observed !== true || chats.has(procId)) return
      // A note written before Claude chats carried a provider is a Codex chat's (ChatSessionManager.adopt)
      chats.set(
        procId,
        meta.restore.provider === 'claude'
          ? { sessionId: meta.id, source: 'claude-chat', read: claudeChatCalls(), mark: { day: null, handing: false } }
          : {
              sessionId: meta.id,
              source: 'codex-chat',
              read: (line) => {
                const c = codexChatCall(line)
                return c ? [c] : []
              },
              mark: { day: null, handing: false }
            }
      )
    }),
    d.procs.onLine((procId, _seq, line) => {
      const chat = chats.get(procId)
      if (!chat || !d.recorder.observing()) return
      try {
        // A line read while observing says a Claude chat ran, whether or not it calls a tool (ruling R6-1)
        if (chat.source === 'claude-chat') handMark(chat.mark, chat.sessionId, 'claude-chat', 'chat-seen')
        const calls = chat.read(line)
        hand(chat.sessionId, chat.source, calls)
        if (chat.source !== 'claude-chat') return
        for (const c of calls) {
          const u = claudeChatUse(c)
          if (u) d.recorder.use({ sessionId: chat.sessionId, source: 'claude-chat', ...u })
        }
      } catch (err) {
        d.log(`audit: a line of chat ${chat.sessionId} could not be read: ${String(err)}`)
      }
    }),
    d.procs.onExit((procId) => {
      chats.delete(procId)
      unfollowEnforce(procId)
    }),
    d.ptys.onMeta((ptyId, meta, why) => {
      if (meta.kind === 'session') followEnforce(ptyId, meta)
      if (meta.kind !== 'session' || meta.restore.observed !== true) return
      let r = rollouts.get(ptyId)
      if (!r) {
        r = { sessionId: meta.id, since: why === 'open' ? now() : null, path: null, tail: null, ended: false, calls: codexRolloutCalls(now), left: [] }
        rollouts.set(ptyId, r)
      }
      const file = str(meta.restore.rolloutPath)
      if (file === null || file === r.path) return
      // A first file of a resumed conversation holds its earlier turns: read from its end, as the rollout watcher does
      // for a path it is handed. A later file is codex's `/new`, all of it this session's. A session whose start this
      // Host did not hear starts at the end too. Lines from before the session's start are passed either way.
      const resumed = r.path === null && str(meta.restore.resumeSessionId) !== null
      // The old file's unread lines may hold the outputs its calls wait for: it is read once more, as on exit, and what
      // still waits then is handed over as unknown
      if (r.tail) r.left.push({ tail: r.tail, calls: r.calls })
      r.calls = codexRolloutCalls(now)
      r.path = file
      r.tail = new JsonlTail(file, { startAtEnd: resumed || r.since === null })
    }),
    d.ptys.onExit((ptyId) => {
      const r = rollouts.get(ptyId)
      // Read once more, for what it wrote last; its enforce file is let go after that last read, which may hand the
      // report of a call the hook stopped (final review M4)
      if (r?.tail) r.ended = true
      else {
        rollouts.delete(ptyId)
        unfollowEnforce(ptyId)
      }
    })
  ]

  /** Whether the files are being read: false while the recorder knows the mode is compatibility. */
  let reading = true
  hooks.start()
  /** Follows the mode: stops the audit watcher when it goes off, and when it may be on again takes the audit files and
   *  the rollouts up from where they end now, so what was written meanwhile is not read. Run when the recorder says the
   *  mode changed, so "now" is the switch, and again at every rollout poll, which finds nothing to do unless that
   *  was missed. */
  const follow = (): boolean => {
    const on = d.recorder.observing()
    if (on && !reading) {
      // The calls made meanwhile were not read, so where they left the shells is not known
      shellAt.clear()
      hooks.start()
      for (const r of rollouts.values()) {
        r.calls.forget()
        r.left = []
        if (r.path !== null) r.tail = new JsonlTail(r.path, { startAtEnd: true })
      }
    } else if (!on && reading) hooks.stop()
    reading = on
    return on
  }
  const offMode = d.recorder.onObservingChange(() => void follow())

  /** The live Claude terminal sessions without the use hooks, by session id, with their mark (ruling R6-8); and, for a note
   *  that does not say, whether its account is Claude's, asked once per session. */
  const unhooked = new Map<string, Mark>()
  const claudeOf = new Map<string, boolean>()
  /** Set while the accounts cannot be read: one log line per streak, as the mode's reads (recorder.ts). */
  let accountsFailing = false
  /** Marks each live, observed Claude terminal session whose note does not say it got the use hooks, from the registry's
   *  list rather than from anything the session sent, so a session that sends nothing is marked too. Never rejects. */
  const markUnhooked = async (): Promise<void> => {
    if (!d.ptys.list) return
    const live = new Set<string>()
    for (const e of d.ptys.list()) {
      const meta = e.meta
      if (!e.alive || meta?.kind !== 'session' || meta.restore.observed !== true || meta.restore.useHooks === true) continue
      const sessionId = meta.id
      live.add(sessionId)
      // A note that says its provider and not `useHooks` is Codex's: a Claude one always says both (ruling R6-10)
      if (meta.restore.useHooks !== false && meta.restore.provider !== undefined && meta.restore.provider !== 'claude') continue
      // A note that says neither is from an app that wrote neither: its account says whether it is Claude's. One whose
      // account is gone is left unmarked, an accepted limit for sessions of an older app
      if (meta.restore.useHooks !== false && meta.restore.provider === undefined) {
        let claude = claudeOf.get(sessionId)
        if (claude === undefined) {
          const accountId = str(meta.restore.accountId)
          if (accountId === null || !d.claudeAccount) continue
          try {
            claude = await d.claudeAccount(accountId)
            accountsFailing = false
          } catch (err) {
            if (!accountsFailing) d.log(`audit: whose account session ${sessionId} runs in could not be read, so it is not marked yet: ${String(err)}`)
            accountsFailing = true
            continue
          }
          claudeOf.set(sessionId, claude)
        }
        if (!claude) continue
      }
      let m = unhooked.get(sessionId)
      if (!m) {
        m = { day: null, handing: false }
        unhooked.set(sessionId, m)
      }
      handMark(m, sessionId, 'claude-hook', 'unhooked')
    }
    for (const id of [...unhooked.keys()]) if (!live.has(id)) unhooked.delete(id)
    for (const id of [...claudeOf.keys()]) if (!live.has(id)) claudeOf.delete(id)
  }

  let polling = false
  const readRollouts = async (): Promise<void> => {
    for (const sessionId of [...enforcing.keys()]) readEnforce(sessionId)
    if (!follow()) return
    try {
      await markUnhooked()
    } catch (err) {
      d.log(`audit: the sessions without the use hooks could not be marked: ${String(err)}`)
    }
    for (const [ptyId, r] of [...rollouts]) {
      for (const old of r.left.splice(0)) {
        try {
          const got = await old.tail.read()
          if (got) hand(r.sessionId, 'codex-rollout', old.calls.read(got.lines, r.since ?? -Infinity))
        } catch (err) {
          d.log(`audit: the rollout of session ${r.sessionId} could not be read: ${String(err)}`)
        }
        hand(r.sessionId, 'codex-rollout', old.calls.unfinished())
      }
      const tail = r.tail
      if (!tail) continue
      const last = r.ended
      const calls = r.calls
      try {
        const got = await tail.read()
        // A file a newer one replaced meanwhile keeps what was read of it, for its last read
        if (got && (r.tail === tail || r.left.some((o) => o.tail === tail))) hand(r.sessionId, 'codex-rollout', calls.read(got.lines, r.since ?? -Infinity))
      } catch (err) {
        d.log(`audit: the rollout of session ${r.sessionId} could not be read: ${String(err)}`)
      }
      if (last) {
        hand(r.sessionId, 'codex-rollout', r.calls.unfinished())
        rollouts.delete(ptyId)
        unfollowEnforce(ptyId)
      } else hand(r.sessionId, 'codex-rollout', r.calls.overdue())
    }
  }
  const every =
    d.every ??
    ((ms: number, fn: () => void) => {
      const t = setInterval(fn, ms)
      t.unref?.()
      return () => clearInterval(t)
    })
  const stopPolling = every(ROLLOUT_POLL_MS, () => {
    d.recorder.retryMode?.()
    if (polling) return
    polling = true
    void readRollouts().finally(() => {
      polling = false
    })
  })

  return {
    poll: async () => {
      await readRollouts()
      if (reading) await hooks.sweep()
    },
    dispose() {
      offMode()
      stopPolling()
      // The Host is leaving: what still waits for an output will never hear it
      for (const r of rollouts.values()) {
        for (const calls of [...r.left.map((o) => o.calls), r.calls]) {
          if (d.recorder.observing()) hand(r.sessionId, 'codex-rollout', calls.unfinished())
          else calls.forget()
        }
      }
      hooks.stop()
      for (const off of offs) off()
      chats.clear()
      rollouts.clear()
      enforcing.clear()
      enforcedBy.clear()
    }
  }
}

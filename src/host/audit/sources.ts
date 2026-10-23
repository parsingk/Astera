// Observe mode's sources (design §5): where the Host hears the tool calls a session finished, read from what each
// provider already writes, and handed to the recorder (recorder.ts) one call at a time. Nothing here waits on a session
// and nothing is written back to one.
//
// - Claude terminal: the PostToolUse lines the capture appends to hook-events/<session>.jsonl (an observed session's
//   hook settings capture every tool, statusline.ts ensureObserveFiles). The Host's hook watcher (rolling.ts) already
//   reads that folder; its tap hands each line to `hook`.
// - Claude and Codex chat: the lines of the chat process, which the Host holds for every chat it carries (procRegistry.ts),
//   whether the app or the Host decodes them. A Claude tool_use is handed over once its tool_result says how it went;
//   a Codex item once it is completed.
// - Codex terminal: the rollout the pty note names (`rolloutPath`, noted by whichever process found it), read forward
//   from the session's start. Its function_call and custom_tool_call lines are the calls (an `exec` script is handed
//   over whole, the resolver reads it), with mcp_tool_call_end, patch_apply_end and web_search_call from versions that
//   write those. Its item_completed lines repeat an exec's inner calls and are not read, or a call would count twice.
//
// Only sessions whose note says they were started observed are followed (Review Focus 1); the recorder asks the same
// of a hook line. The Host reads only what it holds: a session the app runs in its own node-pty, with no Host, is not
// observed (design §8, no second recorder in the app).
//
// Restarts (Review Focus 3): the hook watcher starts every file already there at its end, and a Host's sessions end
// with it (its ptys and chat processes are its children), so a new Host has no earlier line of a live session to read
// again. Within one Host, a call heard twice is kept once by the recorder's dedupe on the provider's call id. What a
// Host does not hear while it is down is lost: the app empties hook-events at its next start.
import { decodeClaudeFrame } from '../../core/chat/claudeProtocol'
import { decodeFrame } from '../../core/chat/codexProtocol'
import { HOOK_EVENT_AT } from '../../core/hooks/eventTime'
import { JsonlTail } from '../../core/rolling/jsonlTail'
import type { AuditSource } from '../../core/audit/store'
import type { PtyMeta } from '../../core/host/protocol'
import type { AuditEvent, AuditRecorder } from './recorder'

/** One finished call as a source reads it, before it is told whose session it was. */
export type ObservedCall = Omit<AuditEvent, 'sessionId' | 'source'>

/** How often the rollouts are read forward: the rollout watcher's own period. */
export const ROLLOUT_POLL_MS = 1_000
/** Claude chat calls that wait for their result, per session, at most; past it the oldest is let go. */
const PENDING_MAX = 200

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

/** A PostToolUse line as one call: Claude Code fires it once a tool has run. Its `tool_response` says whether that
 *  went wrong where the tool reports it (`is_error`, an MCP result's `isError`); without one the outcome is unknown.
 *  null for every other hook event. */
export function hookCall(payload: unknown): ObservedCall | null {
  const p = obj(payload)
  if (!p || p.hook_event_name !== 'PostToolUse') return null
  const tool = str(p.tool_name)
  if (tool === null) return null
  const response = p.tool_response
  const failed = obj(response)?.is_error === true || obj(response)?.isError === true
  const id = str(p.tool_use_id)
  const at = isoOf(p[HOOK_EVENT_AT])
  return {
    tool,
    input: p.tool_input,
    status: response === undefined ? 'unknown' : failed ? 'failed' : 'ok',
    ...(id !== null ? { dedupeKey: id } : {}),
    ...(at !== undefined ? { at } : {})
  }
}

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
 * ran (completed or failed). A declined item did not run, and is not a call. The command line goes to the resolver as
 * a Codex shell call's would; a file change as the files it names.
 */
export function codexChatCall(line: string): ObservedCall | null {
  if (!line.includes('item/completed')) return null
  const f = decodeFrame(line)
  if (f?.kind !== 'notification' || f.method !== 'item/completed') return null
  const params = obj(f.params)
  const item = obj(params?.item)
  const id = str(item?.id)
  if (!item || id === null) return null
  const status = item.status === 'completed' ? 'ok' : item.status === 'failed' ? 'failed' : null
  if (status === null) return null
  const at = isoOf(params?.completedAtMs)
  const call = (tool: string, input: unknown): ObservedCall => ({ tool, input, status, dedupeKey: id, ...(at !== undefined ? { at } : {}) })
  switch (item.type) {
    case 'commandExecution': {
      const workdir = str(item.cwd)
      return call('shell', { command: item.command, ...(workdir !== null ? { workdir } : {}) })
    }
    case 'fileChange': {
      const changes = Array.isArray(item.changes) ? item.changes : []
      return call('apply_patch', patchNaming(changes.map((c) => str(obj(c)?.path)).filter((p): p is string => p !== null)))
    }
    case 'mcpToolCall': {
      const server = str(item.server)
      const tool = str(item.tool)
      return server !== null && tool !== null ? call(`mcp__${server}__${tool}`, {}) : null
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Codex rollout

/** The rollout lines that can be a call, told apart before a line is parsed. */
const ROLLOUT_CALL = /"(?:function_call|custom_tool_call|mcp_tool_call_end|patch_apply_end|web_search_call)"/

/**
 * The calls in rollout lines written at `since` or after (a line without its time is passed). A call's own line has no
 * outcome, so its status is unknown; an end event's says how it went. A call and its end event share the call id, and
 * the recorder keeps whichever it hears first.
 */
export function codexRolloutCalls(lines: readonly string[], since: number): ObservedCall[] {
  const out: ObservedCall[] = []
  for (const line of lines) {
    if (!ROLLOUT_CALL.test(line)) continue
    let o: Record<string, unknown> | null
    try {
      o = obj(JSON.parse(line))
    } catch {
      continue
    }
    const t = Date.parse(str(o?.timestamp) ?? '')
    const p = obj(o?.payload)
    if (!(t >= since) || !p) continue
    const call = rolloutCall(o!.type, p)
    if (call) out.push({ ...call, at: new Date(t).toISOString() })
  }
  return out
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
// The Host's wiring

type Listen<A extends unknown[]> = (cb: (...a: A) => void) => () => void

export interface AuditSources {
  /** The hook watcher's tap: a hook line of a terminal session. Never throws. */
  hook(sessionId: string, payload: unknown): void
  /** Reads every followed rollout forward once (what the timer does). Never rejects. */
  poll(): Promise<void>
  dispose(): void
}

export function createAuditSources(d: {
  recorder: Pick<AuditRecorder, 'record'>
  ptys: { onMeta: Listen<[string, PtyMeta, 'open' | 'note']>; onExit: Listen<[string, number]> }
  procs: { onMeta: Listen<[string, PtyMeta, 'open' | 'note']>; onLine: Listen<[string, number, string]>; onExit: Listen<[string, number]> }
  log(message: string): void
  /** Test injection (epoch ms). */
  now?: () => number
  /** Test injection: how the rollouts are read again; returns the stop. */
  every?: (ms: number, fn: () => void) => () => void
}): AuditSources {
  const now = d.now ?? Date.now
  const hand = (sessionId: string, source: AuditSource, calls: ObservedCall[]): void => {
    for (const c of calls) d.recorder.record({ sessionId, source, ...c })
  }

  /** Observed chat processes, by proc id. */
  const chats = new Map<string, { sessionId: string; source: AuditSource; read: (line: string) => ObservedCall[] }>()
  /** Observed terminal sessions, by pty id: the rollout followed, once the note names one. */
  const rollouts = new Map<
    string,
    { sessionId: string; since: number | null; path: string | null; tail: JsonlTail | null; ended: boolean }
  >()

  const offs = [
    d.procs.onMeta((procId, meta) => {
      if (meta.kind !== 'chat' || meta.restore.observed !== true || chats.has(procId)) return
      // A note written before Claude chats carried a provider is a Codex chat's (ChatSessionManager.adopt)
      chats.set(
        procId,
        meta.restore.provider === 'claude'
          ? { sessionId: meta.id, source: 'claude-chat', read: claudeChatCalls() }
          : {
              sessionId: meta.id,
              source: 'codex-chat',
              read: (line) => {
                const c = codexChatCall(line)
                return c ? [c] : []
              }
            }
      )
    }),
    d.procs.onLine((procId, _seq, line) => {
      const chat = chats.get(procId)
      if (!chat) return
      try {
        hand(chat.sessionId, chat.source, chat.read(line))
      } catch (err) {
        d.log(`audit: a line of chat ${chat.sessionId} could not be read: ${String(err)}`)
      }
    }),
    d.procs.onExit((procId) => void chats.delete(procId)),
    d.ptys.onMeta((ptyId, meta, why) => {
      if (meta.kind !== 'session' || meta.restore.observed !== true) return
      let r = rollouts.get(ptyId)
      if (!r) {
        r = { sessionId: meta.id, since: why === 'open' ? now() : null, path: null, tail: null, ended: false }
        rollouts.set(ptyId, r)
      }
      const file = str(meta.restore.rolloutPath)
      if (file === null || file === r.path) return
      // A first file of a resumed conversation holds its earlier turns: read from its end, as the rollout watcher does
      // for a path it is handed. A later file is codex's `/new`, all of it this session's. A session whose start this
      // Host did not hear starts at the end too. Lines from before the session's start are passed either way.
      const resumed = r.path === null && str(meta.restore.resumeSessionId) !== null
      r.path = file
      r.tail = new JsonlTail(file, { startAtEnd: resumed || r.since === null })
    }),
    d.ptys.onExit((ptyId) => {
      const r = rollouts.get(ptyId)
      if (!r) return
      // Read once more, for what it wrote last
      if (r.tail) r.ended = true
      else rollouts.delete(ptyId)
    })
  ]

  let polling = false
  const poll = async (): Promise<void> => {
    for (const [ptyId, r] of [...rollouts]) {
      const tail = r.tail
      if (!tail) continue
      const last = r.ended
      try {
        const got = await tail.read()
        if (got && r.tail === tail) hand(r.sessionId, 'codex-rollout', codexRolloutCalls(got.lines, r.since ?? -Infinity))
      } catch (err) {
        d.log(`audit: the rollout of session ${r.sessionId} could not be read: ${String(err)}`)
      }
      if (last) rollouts.delete(ptyId)
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
    if (polling || rollouts.size === 0) return
    polling = true
    void poll().finally(() => {
      polling = false
    })
  })

  return {
    hook(sessionId, payload) {
      try {
        const c = hookCall(payload)
        if (c) hand(sessionId, 'claude-hook', [c])
      } catch (err) {
        d.log(`audit: a hook line of session ${sessionId} could not be read: ${String(err)}`)
      }
    },
    poll,
    dispose() {
      stopPolling()
      for (const off of offs) off()
      chats.clear()
      rollouts.clear()
    }
  }
}

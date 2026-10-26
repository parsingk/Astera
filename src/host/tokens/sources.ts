// Where the Host reads the tokens its sessions spent (observe mode design §10), in every mode: nothing here asks the
// observe mode, and nothing new is hooked. Each source is a file or a stream the provider already writes, read from the
// session's own start, one API response at a time (core/usage/claudeTokens.ts, core/usage/codex.ts), and each response
// is handed to the store for whoever the session worked for when it ran.
//
// - Claude terminal: the transcript the session's statusline names (`transcript_path`), and its sub-agents' files in
//   `<transcript>/subagents/`, which hold responses the main file does not (230 beside 199 in one measured session).
//   The statusline's own figures are not a running total (claudeTokens.ts).
// - Claude chat: the lines of its process, which the Host holds for every chat it carries (procRegistry.ts), sub-agent
//   frames among them.
// - Codex terminal and Codex chat: the rollout the pty or process note names (`rolloutPath`), its token_count lines.
//   The app-server writes them as the terminal does, so the chat's `thread/tokenUsage/updated` notifications stay
//   opted out (codexProtocol.ts) and every chat's start is unchanged.
//
// **A session's own start** is when this Host heard it open (or first heard of it). Lines from before it belong to the
// sessions before: a roll's new session works on a copy of the old one's transcript or rollout, and a resumed Codex
// conversation carries its running total on. So each session counts only what it spent itself, a roll's two sessions
// add up once each, and a resumed conversation is not counted twice (Review Focus 5).
//
// **A session's own end** is when its pty or process ended: its last read takes nothing dated after it, since a roll
// onto the same account copies nothing and the next session writes on in the same file, as a Codex chat resumed into
// its own rollout does (fix round 1, I1).
//
// **A file is followed from its end, less TAIL_CAP**, and again so when it gets shorter: transcripts measured up to
// 1 GB and rollouts 93 MB, and what this session wrote is at the end (a session's start is heard well before its first
// response is written).
//
// **Whom a response was for** is `ownerOf` at the response's own time: the Dispatch the session held open then, or one
// that had ended with no person's prompt since (observe deferred minor c), else the Run it coordinated, while that Run
// was unfinished and after it finished until a person prompted the session (final review I2, observe deferred minor b,
// fix round 1 I1). When the state no longer names the session (a roll rekeyed its Dispatch, or its Run's
// coordinator slot, before its last lines were read), the owner it last had stands, within the same bounds. A response
// for nobody (a person's own tab) is not kept. A session the app runs in its own node-pty, with no Host, is not read:
// its Tasks show no tokens.
//
// **A session's turns** are its person's prompts, told by its own lines as they are read (fix round 1, I1): a Claude
// transcript's prompts and a Codex rollout's user_message lines, each unless the Host typed it itself (a nudge, a roll's
// carry-on: the pty or process keeps who sent what, PtyRegistry.submittedBetween) or the agent wrote it for itself (a
// background task's notification, a tool's result); and in a Claude chat's stream, which carries no prompt, the first
// frame after the `result` that ended the turn before, when a person's line reached the chat in between. A turn begun
// any other way goes on with the work before it. The audit asks them too (`SessionTurns`), for the same bound on where
// a coordinator's and a worker's calls are filed.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JsonlTail } from '../../core/rolling/jsonlTail'
import { TAIL_CAP } from '../../core/rolling/tailLines'
import { claudeTokenReader } from '../../core/usage/claudeTokens'
import { codexTokenReader } from '../../core/usage/codex'
import { extractStatusLineSession } from '../../core/usage/statusline'
import { heldPastEnd, outcomeOf, runEndOf } from '../../core/orchestration/running'
import { isRealUserText } from '../../core/history/parser'
import { contentText, isRealCodexUserText } from '../../core/history/codexParser'
import type { OrchState } from '../../core/orchestration/state'
import type { Dispatch, JobRun } from '../../core/orchestration/types'
import type { PtyMeta } from '../../core/host/protocol'
import type { TokensSpent } from '../../core/types'
import type { TokenOwner, TokenStore } from './store'

/** How often the files are read forward. A total is read on demand by `runs get`, and nothing waits on it. */
export const TOKEN_POLL_MS = 5_000

/** The one of `items` with the greatest `key`, the later one on a tie. */
const latest = <T>(items: readonly T[], key: (x: T) => number): T | undefined => {
  let best: T | undefined
  for (const x of items) if (best === undefined || key(x) >= key(best)) best = x
  return best
}

/** Whether the Dispatch was open at `t`: from its start to its end, or on while it has none. */
const held = (x: Dispatch, t: number): boolean => Date.parse(x.startedAt) <= t && (x.endedAt === undefined || t <= Date.parse(x.endedAt))

/** Whether the Dispatch, which ended before `t`, still holds its session's work at `t`: until a person prompts the
 *  session (`heldPastEnd`; observe deferred minor c), so a worker's last response after its report lands in it. */
const heldAfter = (x: Dispatch, t: number, turn: () => number | null): boolean =>
  x.endedAt !== undefined && Date.parse(x.endedAt) < t && heldPastEnd(Date.parse(x.endedAt), t, turn)

/** Whether the coordinator of the Run spent `t` for it: while the Run is unfinished, and after its outcome became final
 *  until a person prompts the session (`heldPastEnd` at `runEndOf`; observe deferred minor b, fix round 1 I1). */
const coordinating = (s: OrchState, r: JobRun, t: number, turn: () => number | null): boolean =>
  outcomeOf(s, r.id) === 'running' || heldPastEnd(runEndOf(s, r), t, turn)

/**
 * Whom a session's response at `at` was for: the session's Dispatch open then (the one started last, when two were),
 * else the one that ended last with no person's prompt since, else the Run whose coordinator the session is while it
 * coordinates it (`coordinating`), the unfinished one first. A Dispatch holds what was spent while it was open, read
 * late or not, and after its end until a person prompts the session, so a worker's last response after its report lands
 * in it (observe deferred minor c); not what a person's prompt afterwards led to (fix round 1, ruling 3): a tab a worker
 * was typed into (`worker-start --terminal`) goes on after the Dispatch ended, and that is not the Task's work, nor is
 * what it spent before. A finished Run's coordinator holds its wrap-up the same way, woken by a background task's end or
 * Astera's nudge or not: a person's prompt typed into its tab after the end is nobody's Run.
 *
 * `turn` is when the turn holding `at` began, at the latest (epoch ms): the person's last prompt at or before it, as the
 * session's own lines tell it (createTokenSources' turns); null when they cannot, and then two minutes after the end
 * stand in for it.
 *
 * `last` is the owner the session's earlier responses had. It stands for a session the state no longer names (a roll
 * rekeyed its Dispatch or its Run's coordinator slot before its last lines were read), within the same bounds: a
 * Dispatch still there and open at `at`, a Run still there and coordinated at `at`. Null for a session that worked for
 * nobody then. A session that drives a Run from outside is not looked for.
 */
export function tokenOwnerOf(s: OrchState, sessionId: string, at: string, last: TokenOwner | null = null, turn: number | null = null): TokenOwner | null {
  const t = Date.parse(at)
  const turnOf = (): number | null => turn
  const mine = s.dispatches.filter((x: Dispatch) => x.sessionId === sessionId)
  const dispatch =
    latest(
      mine.filter((x) => held(x, t)),
      (x) => Date.parse(x.startedAt)
    ) ??
    latest(
      mine.filter((x) => heldAfter(x, t, turnOf)),
      (x) => Date.parse(x.endedAt!)
    )
  if (dispatch) return { dispatchId: dispatch.id }
  const coordinated = s.runs.filter((r: JobRun) => r.coordinatorSessionId === sessionId)
  if (coordinated.length > 0) {
    const unfinished = coordinated.filter((r) => outcomeOf(s, r.id) === 'running')
    const run = latest(unfinished.length > 0 ? unfinished : coordinated.filter((r) => coordinating(s, r, t, turnOf)), (r) => Date.parse(r.createdAt))
    return run ? { coordinatorOf: run.id } : null
  }
  if (last === null) return null
  if ('dispatchId' in last) {
    const x = s.dispatches.find((d) => d.id === last.dispatchId)
    return x && (held(x, t) || heldAfter(x, t, turnOf)) ? last : null
  }
  const run = s.runs.find((r) => r.id === last.coordinatorOf)
  return run && coordinating(s, run, t, turnOf) ? last : null
}

/** A session's turns as its own lines tell them (observe deferred minor b, fix round 1 I1): when a person prompted it,
 *  in order. Only a person's prompt begins a turn here: one Astera typed (a nudge, a roll's carry-on) and one Claude
 *  Code writes when a background task ends go on with the work before them, so a coordinator's wrap-up woken by either
 *  is still its Run's. */
interface Turns {
  starts: number[]
  /** The turn holding a moment before every start kept began no later than this: the first line read, or the latest
   *  start let go of. Null before a line with a time was read. */
  from: number | null
}

/** Starts kept per session; past it the earliest goes, and `from` takes its place. */
const TURNS_KEPT = 256
/** Turn logs kept after their sessions are let go, for a roll's successor (`seedFrom`); past it the oldest goes. */
const RETIRED_KEPT = 64

/** How long before a prompt line the Enter that sent it may have come: the Host's own typing within it makes the prompt
 *  Astera's (PtyRegistry.submittedBetween). A prompt typed while the agent was busy is written once it is taken, later
 *  than this, and is read as a person's. */
export const TYPED_WITHIN_MS = 30_000

/** When the turn holding `t` began, at the latest; null when the lines read cannot tell. */
const turnIn = (log: Turns, t: number): number | null => {
  for (let i = log.starts.length - 1; i >= 0; i--) if (log.starts[i] <= t) return log.starts[i]
  return log.from !== null && log.from <= t ? log.from : null
}

const parsed = (line: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(line)
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}
const timeOf = (o: Record<string, unknown> | null): number | null => {
  const at = typeof o?.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
  return Number.isFinite(at) ? at : null
}

/** The text of a user line's content: the string, or its text blocks joined. */
const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((b) => ((b as { type?: unknown } | null)?.type === 'text' ? String((b as { text?: unknown }).text ?? '') : '')).join('')
      : ''

/** Whether a user line's text is something typed into the session: not a record Claude Code writes for itself (a
 *  background task's notification, a local command's output, an interruption's note; parser.ts isRealUserText), though
 *  a slash command or a `!` command a person typed is. */
const typedText = (text: string): boolean => isRealUserText(text) || /^<(?:command-(?:name|message)|bash-input)>/.test(text.trim())

/** When a Claude transcript line is a prompt typed into the session, by a person or by Astera: a user line of the main
 *  conversation that is not a tool's result coming back, nor one Claude Code writes for itself (`isMeta`, a compaction's
 *  summary, a background task's notification: `promptSource: 'system'`, `turnOrigin: 'task_notification'`, or text
 *  that opens `<task-notification>`). Null for any other line. A tool's result, often a file's whole contents, is passed
 *  by unparsed: `"tool_result"` unescaped is only ever its block's type. */
const claudeTypedAt = (line: string): number | null => {
  if (!line.includes('"user"') || line.includes('"tool_result"')) return null
  const o = parsed(line)
  if (!o || o.type !== 'user' || o.isSidechain === true || o.isMeta === true || o.isCompactSummary === true) return null
  if (o.promptSource === 'system' || o.turnOrigin === 'task_notification') return null
  return typedText(textOf((o.message as { content?: unknown } | undefined)?.content)) ? timeOf(o) : null
}

/** When a Codex rollout line is a prompt typed into the session, by a person or by Astera: a user message item (a
 *  `response_item` of `role: 'user'`, its text blocks joined; what Codex 0.160 to 0.164 write), or an older Codex's
 *  `user_message` event, either one not a wrapper Codex puts there itself (its environment, the project's AGENTS.md, an
 *  agent history, a task notification; codexParser.ts isRealCodexUserText). Every turn has a `task_started`, Astera's
 *  and Codex's own (a `/goal` carried on) too, so that mark says nothing about who began it. Null for any other line. */
const codexTypedAt = (line: string): number | null => {
  if (!line.includes('"role":"user"') && !line.includes('"user_message"')) return null
  const o = parsed(line)
  const p = o?.payload as { type?: unknown; role?: unknown; content?: unknown; message?: unknown } | undefined
  const text =
    o?.type === 'response_item' && p?.type === 'message' && p.role === 'user'
      ? contentText(p.content)
      : o?.type === 'event_msg' && p?.type === 'user_message' && typeof p.message === 'string'
        ? p.message
        : null
  return text !== null && isRealCodexUserText(text) ? timeOf(o) : null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** A file followed from its end less TAIL_CAP, and again so when it gets shorter (made again), never read whole; a cut
 *  first line does not parse and is passed by the readers. The session's reader goes on across such a restart, so a
 *  response met again is not counted again (fix round 1, ruling 1). `from`: follow it from this byte instead, where it
 *  ended when it was passed by (a sub-agent file looked at again, fix round 1 Minor 4), so nothing it gained since is
 *  missed however much it was. */
const follow = async (file: string, from?: number): Promise<JsonlTail> => {
  if (from !== undefined) return new JsonlTail(file, { offset: from, restartWithin: TAIL_CAP })
  const size = await fs.stat(file).then(
    (st) => st.size,
    () => 0
  )
  return new JsonlTail(file, { offset: Math.max(0, size - TAIL_CAP), restartWithin: TAIL_CAP })
}

type Listen<A extends unknown[]> = (cb: (...a: A) => void) => () => void
/** Who sent the latest of what an entry was given in (from, to]: a person, the Host itself, or null for nothing kept. */
type SentBy = (id: string, from: number, to: number) => 'person' | 'host' | null

/** One session followed: its rollout (Codex), its transcript files (Claude terminal), or its process lines (Claude
 *  chat, read as they come). */
interface Followed {
  sessionId: string
  /** Its pty's id (a terminal) or its process's (a chat), where who sent each prompt is kept (`submittedBetween`). */
  key: string
  via: 'pty' | 'proc'
  since: number
  rollout: { path: string; tail: JsonlTail | null; read: (lines: readonly string[]) => TokensSpent[] } | null
  /** Claude terminal: one reader over the transcript and its sub-agents' files, by path, and every sub-agent file looked
   *  at and passed by, with its size then. Null for a Codex session. */
  transcript: { read: (lines: readonly string[]) => TokensSpent[]; files: Map<string, JsonlTail>; seen: Map<string, number> } | null
  chat: ((lines: readonly string[]) => TokensSpent[]) | null
  /** A Claude chat: whether a turn is under way, begun by its first frame after the `result` that ended the one before,
   *  and when the last one began (or when the chat was first heard of). */
  chatTurn: boolean
  chatTurnAt: number
  /** When its pty or process ended (epoch ms), null while it runs. Its last read takes nothing dated after it. */
  endedAt: number | null
  /** When its last read of its files began (epoch ms), null before one: what was written before it is read. */
  readFrom: number | null
}

/** A session's turns as the token sources read them, for the audit's lookup (recorder.ts `dispatchOfWithTurns`). */
export interface SessionTurns {
  /** When the turn holding `t` (epoch ms) began, at the latest: a person's last prompt at or before it, from the
   *  session's lines read so far (`Turns`); null when they cannot tell: none read, a moment before them, a session not
   *  followed. */
  turnOf(sessionId: string, t: number): number | null
  /** Null when the session's files were last read from a moment at or after `t`, so a prompt written before it is
   *  known, and when it has none to read (not followed, or a Claude chat, whose lines are read as they come); else a
   *  read of every followed file that begins now, or right after the one under way. Never rejects. */
  readPast(sessionId: string, t: number): Promise<void> | null
}

export interface TokenSources extends SessionTurns {
  /** Reads every followed file forward once (after the read under way, if one is) and saves the store. Never rejects. */
  poll(): Promise<void>
  dispose(): void
}

export function createTokenSources(d: {
  store: Pick<TokenStore, 'add' | 'save'>
  /** Each registry also says who sent what an entry was last given (PtyRegistry.submittedBetween,
   *  ProcRegistry.submittedBetween): a prompt the Host typed itself is not a person's. Without it, every prompt is. */
  ptys: { onMeta: Listen<[string, PtyMeta, 'open' | 'note']>; onExit: Listen<[string, number]>; submittedBetween?: SentBy }
  procs: {
    onMeta: Listen<[string, PtyMeta, 'open' | 'note']>
    onLine: Listen<[string, number, string]>
    onExit: Listen<[string, number]>
    submittedBetween?: SentBy
  }
  /** A Claude terminal session's statusline payload, which names its transcript; null before it has one. */
  statusLinePayload(sessionId: string): Promise<unknown | null>
  /** `tokenOwnerOf` over the state now; `last` is the owner the session's earlier responses had, `turn` when the turn
   *  holding `at` began, at the latest, or null when the session's lines cannot tell. */
  ownerOf(sessionId: string, at: string, last: TokenOwner | null, turn: number | null): TokenOwner | null
  log(message: string): void
  /** Test injection (epoch ms). */
  now?: () => number
  /** Test injection: how the files are read again; returns the stop. */
  every?: (ms: number, fn: () => void) => () => void
}): TokenSources {
  const now = d.now ?? Date.now
  /** The owner each session last had, for its lines read after the state stopped naming it. */
  const lastOwner = new Map<string, TokenOwner>()
  /** Each session's turns, from its main file's lines (its transcript or rollout) or its chat frames. */
  const turns = new Map<string, Turns>()
  const turnsFor = (sessionId: string): Turns => {
    let log = turns.get(sessionId)
    if (!log) turns.set(sessionId, (log = { starts: [], from: null }))
    return log
  }
  /** The turns of sessions let go of lately, newest last, for a roll's successor heard after its predecessor's last read
   *  (`seedFrom`). */
  const retired = new Map<string, Turns>()
  /** A roll's new session (`rolledFrom` in its note) goes on with its predecessor's work: it starts from that session's
   *  turns, so a wrap-up the roll moved is held as it was, until a person prompts the new one (fix round 2). Its own lines
   *  are added as they are read. */
  const seedFrom = (sessionId: string, meta: PtyMeta): void => {
    const from = str(meta.restore.rolledFrom)
    const before = from === null ? undefined : (turns.get(from) ?? retired.get(from))
    if (!before || turns.has(sessionId)) return
    turns.set(sessionId, { starts: [...before.starts], from: before.from })
  }
  const turnBegan = (log: Turns, at: number): void => {
    let i = log.starts.length
    while (i > 0 && log.starts[i - 1] > at) i--
    if (log.starts[i - 1] === at) return
    log.starts.splice(i, 0, at)
    if (log.starts.length > TURNS_KEPT) log.from = log.starts.shift()!
  }
  /** Who sent the latest of what the session's pty or process was given in (from, to]; null when nothing is kept. */
  const sentBy = (f: Followed, from: number, to: number): 'person' | 'host' | null =>
    (f.via === 'pty' ? d.ptys.submittedBetween?.(f.key, from, to) : d.procs.submittedBetween?.(f.key, from, to)) ?? null
  /** Notes the person's prompts among `lines` of a session's main file, and the first moment read. `typedAt` tells a
   *  prompt typed into it; one the Host's own typing sent within TYPED_WITHIN_MS before it is Astera's, not a person's. */
  const noteTurns = (f: Followed, lines: readonly string[], typedAt: (line: string) => number | null): void => {
    const log = turnsFor(f.sessionId)
    if (log.from === null)
      for (const line of lines) {
        const at = timeOf(parsed(line))
        if (at === null) continue
        log.from = at
        break
      }
    for (const line of lines) {
      const at = typedAt(line)
      if (at !== null && sentBy(f, at - TYPED_WITHIN_MS, at) !== 'host') turnBegan(log, at)
    }
  }
  /** A Claude chat frame's part in its turns: a `result` ends the turn under way, and the first frame of the model's after
   *  it begins the next one, at its time. That turn is a person's when a person's turn line reached the chat since the
   *  turn before began: after that turn's `result`, or during it, since the chat takes a line written mid-turn once the
   *  turn ends (fix round 2). Only turn lines are marked a person's, so a card answered mid-turn does not count. One a
   *  background task's end began, or one the Host sent itself, goes on with the work before it. */
  const noteChatTurn = (f: Followed, line: string): void => {
    if (!line.includes('"result"') && !line.includes('"assistant"')) return
    const o = parsed(line)
    if (o?.type === 'result') f.chatTurn = false
    else if (o?.type === 'assistant' && !f.chatTurn) {
      f.chatTurn = true
      const before = f.chatTurnAt
      f.chatTurnAt = now()
      if (sentBy(f, before, f.chatTurnAt) === 'person') turnBegan(turnsFor(f.sessionId), timeOf(o) ?? f.chatTurnAt)
    }
  }
  /** Lets go of what is kept for a session once nothing follows it. */
  const forget = (sessionId: string): void => {
    if ([...terminals.values(), ...chats.values()].some((x) => x.sessionId === sessionId)) return
    lastOwner.delete(sessionId)
    const log = turns.get(sessionId)
    turns.delete(sessionId)
    if (!log) return
    retired.delete(sessionId)
    retired.set(sessionId, log)
    if (retired.size > RETIRED_KEPT) retired.delete(retired.keys().next().value as string)
  }
  const hand = (f: Followed, spent: TokensSpent[]): void => {
    for (const x of spent) {
      const at = x.at ?? new Date(now()).toISOString()
      // An ended session's file can be written on by the next one (a roll onto the same account copies nothing, a Codex
      // chat resumes into its own rollout): what is dated after the end is that one's (fix round 1, I1)
      if (f.endedAt !== null && !(Date.parse(at) <= f.endedAt)) continue
      const log = turns.get(f.sessionId)
      const owner = d.ownerOf(f.sessionId, at, lastOwner.get(f.sessionId) ?? null, log ? turnIn(log, Date.parse(at)) : null)
      if (!owner) continue
      lastOwner.set(f.sessionId, owner)
      d.store.add(f.sessionId, owner, x)
    }
  }

  /** Followed sessions: a terminal by its pty id, a chat by its process id. */
  const terminals = new Map<string, Followed>()
  const chats = new Map<string, Followed>()
  const fresh = (sessionId: string, key: string, via: Followed['via']): Followed => {
    const since = now()
    return { sessionId, key, via, since, rollout: null, transcript: null, chat: null, chatTurn: false, chatTurnAt: since, endedAt: null, readFrom: null }
  }
  /** The rollout a note names, followed from now on when it is new: a later file is Codex's `/new`, a conversation of
   *  its own with its own running total. */
  const noteRollout = (f: Followed, meta: PtyMeta): void => {
    const file = str(meta.restore.rolloutPath)
    if (file === null || file === f.rollout?.path) return
    f.rollout = { path: file, tail: null, read: codexTokenReader(f.since) }
    f.transcript = null
  }

  const offs = [
    d.ptys.onMeta((ptyId, meta) => {
      if (meta.kind !== 'session') return
      let f = terminals.get(ptyId)
      if (!f) {
        f = fresh(meta.id, ptyId, 'pty')
        seedFrom(f.sessionId, meta)
        // A terminal without a rollout is read as Claude's, through its statusline, until a note names one
        f.transcript = { read: claudeTokenReader(f.since), files: new Map(), seen: new Map() }
        terminals.set(ptyId, f)
      }
      noteRollout(f, meta)
    }),
    d.ptys.onExit((ptyId) => {
      const f = terminals.get(ptyId)
      if (f) f.endedAt = now()
    }),
    d.procs.onMeta((procId, meta) => {
      if (meta.kind !== 'chat') return
      let f = chats.get(procId)
      if (!f) {
        f = fresh(meta.id, procId, 'proc')
        seedFrom(f.sessionId, meta)
        // A note written before Claude chats carried a provider is a Codex chat's (ChatSessionManager.adopt)
        if (meta.restore.provider === 'claude') {
          f.chat = claudeTokenReader(f.since)
          // Its every line is read as it comes from now on, so whatever it does before a person writes to it is the work
          // it was started for
          const log = turnsFor(f.sessionId)
          log.from ??= f.since
        }
        chats.set(procId, f)
      }
      if (!f.chat) noteRollout(f, meta)
    }),
    d.procs.onLine((procId, _seq, line) => {
      const f = chats.get(procId)
      if (!f?.chat) return
      try {
        noteChatTurn(f, line)
        hand(f, f.chat([line]))
      } catch (err) {
        d.log(`tokens: a line of chat ${f.sessionId} could not be read: ${String(err)}`)
      }
    }),
    d.procs.onExit((procId) => {
      const f = chats.get(procId)
      if (!f) return
      // A Claude chat's lines were all read as they came; a Codex chat's rollout is read once more, up to now
      if (f.chat) {
        chats.delete(procId)
        f.chat = null
        forget(f.sessionId)
      } else f.endedAt = now()
    })
  ]

  /** Reads `tail` forward and hands what it spent, after the person's prompts among its lines when it is the session's
   *  main file (`typedAt`); true when lines came. */
  const readTail = async (
    f: Followed,
    tail: JsonlTail,
    read: (lines: readonly string[]) => TokensSpent[],
    typedAt?: (line: string) => number | null
  ): Promise<boolean> => {
    const got = await tail.read()
    if (!got || got.lines.length === 0) return false
    if (typedAt) noteTurns(f, got.lines, typedAt)
    hand(f, read(got.lines))
    return true
  }

  const readOne = async (f: Followed): Promise<void> => {
    if (f.rollout) {
      const r = f.rollout
      r.tail ??= await follow(r.path)
      if (f.rollout === r) await readTail(f, r.tail, r.read, codexTypedAt)
      return
    }
    const t = f.transcript
    if (!t) return
    const named = extractStatusLineSession(await d.statusLinePayload(f.sessionId).catch(() => null)).transcriptPath
    if (named !== null) {
      let main = t.files.get(named)
      if (!main) t.files.set(named, (main = await follow(named)))
      // Its person's prompts tell its turns; its sub-agents' files hold none (their prompts come from it)
      const grew = await readTail(f, main, t.read, claudeTypedAt)
      // A sub-agent writes a file of its own beside the transcript, made when it starts. One last written before this
      // session started is a session before's, in a resumed conversation's folder (fix round 1, ruling 2): not
      // followed. Each file is looked at when the folder first lists it, not at every read (final review M3); one that
      // could not be looked at is tried again at the next. One passed by is looked at again only on a read where the
      // main transcript grew, as it does around a sub-agent's work: a sub-agent resumed in a resumed conversation writes
      // on in its own old file (deferred minor a), followed then from where it ended when it was passed by (fix round 1,
      // Minor 4), and the reader's message ids count what it holds once
      const agents = path.join(path.dirname(named), path.basename(named, '.jsonl'), 'subagents')
      const names = await fs.readdir(agents).catch(() => [] as string[])
      for (const n of names) {
        const file = path.join(agents, n)
        if (!n.endsWith('.jsonl') || t.files.has(file) || (t.seen.has(file) && !grew)) continue
        const st = await fs.stat(file).then(
          (s) => ({ written: s.mtimeMs, size: s.size }),
          () => null
        )
        if (st === null) continue
        if (st.written >= f.since) t.files.set(file, await follow(file, t.seen.get(file)))
        else if (!t.seen.has(file)) t.seen.set(file, st.size)
      }
    }
    for (const [file, tail] of t.files) if (file !== named) await readTail(f, tail, t.read)
  }

  /** Reads each of `followed` forward; one that had ended is read this last time and let go. */
  const readEach = async (followed: Map<string, Followed>): Promise<void> => {
    for (const [key, f] of [...followed]) {
      const last = f.endedAt !== null
      const from = now()
      try {
        await readOne(f)
        f.readFrom = from
      } catch (err) {
        d.log(`tokens: the files of session ${f.sessionId} could not be read: ${String(err)}`)
      }
      if (!last) continue
      followed.delete(key)
      // Its readers go with it: the message ids it counted and the files it followed
      f.transcript = null
      f.rollout = null
      forget(f.sessionId)
    }
  }
  const readAll = async (): Promise<void> => {
    await readEach(terminals)
    await readEach(chats)
    await d.store.save()
  }

  /** The read under way, and the one asked for after it. */
  let reading: Promise<void> | null = null
  let next: Promise<void> | null = null
  /** A read of every followed file that begins now, or right after the one under way: one begun before the ask may
   *  have passed by what was written since. */
  const readSoon = (): Promise<void> => {
    if (reading === null) {
      reading = readAll().finally(() => {
        reading = null
      })
      return reading
    }
    next ??= reading.then(() => {
      next = null
      return readSoon()
    })
    return next
  }
  const every =
    d.every ??
    ((ms: number, fn: () => void) => {
      const t = setInterval(fn, ms)
      t.unref?.()
      return () => clearInterval(t)
    })
  const stopPolling = every(TOKEN_POLL_MS, () => {
    if (reading === null) void readSoon()
  })

  return {
    poll: readSoon,
    turnOf(sessionId, t) {
      const log = turns.get(sessionId)
      return log ? turnIn(log, t) : null
    },
    readPast(sessionId, t) {
      const files = [...terminals.values(), ...chats.values()].filter((f) => f.sessionId === sessionId && f.chat === null)
      return files.every((f) => f.readFrom !== null && f.readFrom >= t) ? null : readSoon()
    },
    dispose() {
      stopPolling()
      for (const off of offs) off()
      terminals.clear()
      chats.clear()
      lastOwner.clear()
      turns.clear()
      retired.clear()
    }
  }
}

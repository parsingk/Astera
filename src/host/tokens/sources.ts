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
// **A file is followed from its end, less TAIL_CAP**: transcripts measured up to 1 GB and rollouts 93 MB, and what
// this session wrote is at the end (a session's start is heard well before its first response is written).
//
// **Whom a response was for** is `ownerOf` at the response's own time: the Dispatch the session held then, else the
// Run it coordinated. When the state no longer names the session (a roll rekeyed its Dispatch, or its Run's coordinator
// slot, before its last lines were read), the owner it last had stands. A response for nobody (a person's own tab) is
// not kept. A session the app runs in its own node-pty, with no Host, is not read: its Tasks show no tokens.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JsonlTail } from '../../core/rolling/jsonlTail'
import { TAIL_CAP } from '../../core/rolling/tailLines'
import { claudeTokenReader } from '../../core/usage/claudeTokens'
import { codexTokenReader } from '../../core/usage/codex'
import { extractStatusLineSession } from '../../core/usage/statusline'
import { outcomeOf } from '../../core/orchestration/running'
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

/**
 * Whom a session's response at `at` was for: the session's Dispatch that started last at or before it (one that has
 * ended included, so a worker's last words after its report still count for it), else the Run whose coordinator the
 * session is, the unfinished one first. Null for a session that worked for nobody then, a person's own tab before a
 * worker was typed into it among them. A session that drives a Run from outside is not looked for.
 */
export function tokenOwnerOf(s: OrchState, sessionId: string, at: string): TokenOwner | null {
  const t = Date.parse(at)
  const dispatch = latest(
    s.dispatches.filter((x: Dispatch) => x.sessionId === sessionId && Date.parse(x.startedAt) <= t),
    (x) => Date.parse(x.startedAt)
  )
  if (dispatch) return { dispatchId: dispatch.id }
  const coordinated = s.runs.filter((r: JobRun) => r.coordinatorSessionId === sessionId)
  if (coordinated.length === 0) return null
  const unfinished = coordinated.filter((r) => outcomeOf(s, r.id) === 'running')
  return { coordinatorOf: latest(unfinished.length > 0 ? unfinished : coordinated, (r) => Date.parse(r.createdAt))!.id }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** A file followed from its end less TAIL_CAP; a cut first line does not parse and is passed by the readers. */
const follow = async (file: string): Promise<JsonlTail> => {
  const size = await fs.stat(file).then(
    (st) => st.size,
    () => 0
  )
  return new JsonlTail(file, { offset: Math.max(0, size - TAIL_CAP) })
}

type Listen<A extends unknown[]> = (cb: (...a: A) => void) => () => void

/** One session followed: its rollout (Codex), its transcript files (Claude terminal), or its process lines (Claude
 *  chat, read as they come). */
interface Followed {
  sessionId: string
  since: number
  rollout: { path: string; tail: JsonlTail | null; read: (lines: readonly string[]) => TokensSpent[] } | null
  /** Claude terminal: one reader over the transcript and its sub-agents' files, by path. Null for a Codex session. */
  transcript: { read: (lines: readonly string[]) => TokensSpent[]; files: Map<string, JsonlTail> } | null
  chat: ((lines: readonly string[]) => TokensSpent[]) | null
  ended: boolean
}

export interface TokenSources {
  /** Reads every followed file forward once and saves the store. Never rejects. */
  poll(): Promise<void>
  dispose(): void
}

export function createTokenSources(d: {
  store: Pick<TokenStore, 'add' | 'save'>
  ptys: { onMeta: Listen<[string, PtyMeta, 'open' | 'note']>; onExit: Listen<[string, number]> }
  procs: { onMeta: Listen<[string, PtyMeta, 'open' | 'note']>; onLine: Listen<[string, number, string]>; onExit: Listen<[string, number]> }
  /** A Claude terminal session's statusline payload, which names its transcript; null before it has one. */
  statusLinePayload(sessionId: string): Promise<unknown | null>
  ownerOf(sessionId: string, at: string): TokenOwner | null
  log(message: string): void
  /** Test injection (epoch ms). */
  now?: () => number
  /** Test injection: how the files are read again; returns the stop. */
  every?: (ms: number, fn: () => void) => () => void
}): TokenSources {
  const now = d.now ?? Date.now
  /** The owner each session last had, for its lines read after the state stopped naming it. */
  const lastOwner = new Map<string, TokenOwner>()
  const hand = (sessionId: string, spent: TokensSpent[]): void => {
    for (const x of spent) {
      const owner = d.ownerOf(sessionId, x.at ?? new Date(now()).toISOString()) ?? lastOwner.get(sessionId) ?? null
      if (!owner) continue
      lastOwner.set(sessionId, owner)
      d.store.add(sessionId, owner, x)
    }
  }

  /** Followed sessions: a terminal by its pty id, a chat by its process id. */
  const terminals = new Map<string, Followed>()
  const chats = new Map<string, Followed>()
  const fresh = (sessionId: string): Followed => ({ sessionId, since: now(), rollout: null, transcript: null, chat: null, ended: false })
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
        f = fresh(meta.id)
        // A terminal without a rollout is read as Claude's, through its statusline, until a note names one
        f.transcript = { read: claudeTokenReader(f.since), files: new Map() }
        terminals.set(ptyId, f)
      }
      noteRollout(f, meta)
    }),
    d.ptys.onExit((ptyId) => {
      const f = terminals.get(ptyId)
      if (f) f.ended = true
    }),
    d.procs.onMeta((procId, meta) => {
      if (meta.kind !== 'chat') return
      let f = chats.get(procId)
      if (!f) {
        f = fresh(meta.id)
        // A note written before Claude chats carried a provider is a Codex chat's (ChatSessionManager.adopt)
        if (meta.restore.provider === 'claude') f.chat = claudeTokenReader(f.since)
        chats.set(procId, f)
      }
      if (!f.chat) noteRollout(f, meta)
    }),
    d.procs.onLine((procId, _seq, line) => {
      const f = chats.get(procId)
      if (!f?.chat) return
      try {
        hand(f.sessionId, f.chat([line]))
      } catch (err) {
        d.log(`tokens: a line of chat ${f.sessionId} could not be read: ${String(err)}`)
      }
    }),
    d.procs.onExit((procId) => {
      const f = chats.get(procId)
      if (!f) return
      // A Claude chat's lines were all read as they came; a Codex chat's rollout is read once more
      if (f.chat) chats.delete(procId)
      else f.ended = true
    })
  ]

  const readTail = async (f: Followed, tail: JsonlTail, read: (lines: readonly string[]) => TokensSpent[]): Promise<void> => {
    const got = await tail.read()
    if (got && got.lines.length > 0) hand(f.sessionId, read(got.lines))
  }

  const readOne = async (f: Followed): Promise<void> => {
    if (f.rollout) {
      const r = f.rollout
      r.tail ??= await follow(r.path)
      if (f.rollout === r) await readTail(f, r.tail, r.read)
      return
    }
    const t = f.transcript
    if (!t) return
    const named = extractStatusLineSession(await d.statusLinePayload(f.sessionId).catch(() => null)).transcriptPath
    if (named !== null) {
      if (!t.files.has(named)) t.files.set(named, await follow(named))
      // A sub-agent writes a file of its own beside the transcript, made when it starts
      const agents = path.join(path.dirname(named), path.basename(named, '.jsonl'), 'subagents')
      const names = await fs.readdir(agents).catch(() => [] as string[])
      for (const n of names) {
        const file = path.join(agents, n)
        if (n.endsWith('.jsonl') && !t.files.has(file)) t.files.set(file, await follow(file))
      }
    }
    for (const tail of t.files.values()) await readTail(f, tail, t.read)
  }

  /** Reads each of `followed` forward; one that had ended is read this last time and let go. */
  const readEach = async (followed: Map<string, Followed>): Promise<void> => {
    for (const [key, f] of [...followed]) {
      const last = f.ended
      try {
        await readOne(f)
      } catch (err) {
        d.log(`tokens: the files of session ${f.sessionId} could not be read: ${String(err)}`)
      }
      if (!last) continue
      followed.delete(key)
      if (![...terminals.values(), ...chats.values()].some((x) => x.sessionId === f.sessionId)) lastOwner.delete(f.sessionId)
    }
  }
  const readAll = async (): Promise<void> => {
    await readEach(terminals)
    await readEach(chats)
    await d.store.save()
  }

  let polling = false
  const every =
    d.every ??
    ((ms: number, fn: () => void) => {
      const t = setInterval(fn, ms)
      t.unref?.()
      return () => clearInterval(t)
    })
  const stopPolling = every(TOKEN_POLL_MS, () => {
    if (polling) return
    polling = true
    void readAll().finally(() => {
      polling = false
    })
  })

  return {
    poll: readAll,
    dispose() {
      stopPolling()
      for (const off of offs) off()
      terminals.clear()
      chats.clear()
      lastOwner.clear()
    }
  }
}

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
// **Whom a response was for** is `ownerOf` at the response's own time: the Dispatch the session held open then (one
// that ended holds nothing after its end), else the Run it coordinated, while that Run was unfinished or had just
// finished (final review I2). When the state no longer names the session (a
// roll rekeyed its Dispatch, or its Run's coordinator slot, before its last lines were read), the owner it last had
// stands, within the same bounds. A response for nobody (a person's own tab) is not kept. A session the app runs in its
// own node-pty, with no Host, is not read: its Tasks show no tokens.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JsonlTail } from '../../core/rolling/jsonlTail'
import { TAIL_CAP } from '../../core/rolling/tailLines'
import { claudeTokenReader } from '../../core/usage/claudeTokens'
import { codexTokenReader } from '../../core/usage/codex'
import { extractStatusLineSession } from '../../core/usage/statusline'
import { outcomeOf, tasksOwnedBy, withoutSupersededLifecycle } from '../../core/orchestration/running'
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

/** How long after its Run finished a coordinator's response is still the Run's: the last ones are written as it
 *  finishes. Past it, a finished Run's coordinator tab used on is nobody's Run (final review I2; the recorder's
 *  DISPATCH_END_GRACE_MS). */
export const RUN_END_GRACE_MS = 2 * 60 * 1000

/** Whether the coordinator of the Run spent `t` for it: while the Run is unfinished, and up to RUN_END_GRACE_MS after it
 *  finished, which is when its last Task last changed. */
const coordinating = (s: OrchState, r: JobRun, t: number): boolean => {
  if (outcomeOf(s, r.id) === 'running') return true
  const finished = Math.max(...withoutSupersededLifecycle(tasksOwnedBy(s, r.id)).map((x) => Date.parse(x.updatedAt)))
  return t <= finished + RUN_END_GRACE_MS
}

/**
 * Whom a session's response at `at` was for: the session's Dispatch open then (the one started last, when two were),
 * else the Run whose coordinator the session is while it coordinates it (`coordinating`), the unfinished one first. A
 * Dispatch holds only what was spent while it was open, read late or not (fix round 1, ruling 3): a tab a worker was
 * typed into (`worker-start --terminal`) goes on after the Dispatch ended, and that is not the Task's work, nor is what
 * it spent before. A finished Run's coordinator tab is the same.
 *
 * `last` is the owner the session's earlier responses had. It stands for a session the state no longer names (a roll
 * rekeyed its Dispatch or its Run's coordinator slot before its last lines were read), within the same bounds: a
 * Dispatch still there and open at `at`, a Run still there and coordinated at `at`. Null for a session that worked for
 * nobody then. A session that drives a Run from outside is not looked for.
 */
export function tokenOwnerOf(s: OrchState, sessionId: string, at: string, last: TokenOwner | null = null): TokenOwner | null {
  const t = Date.parse(at)
  const dispatch = latest(
    s.dispatches.filter((x: Dispatch) => x.sessionId === sessionId && held(x, t)),
    (x) => Date.parse(x.startedAt)
  )
  if (dispatch) return { dispatchId: dispatch.id }
  const coordinated = s.runs.filter((r: JobRun) => r.coordinatorSessionId === sessionId)
  if (coordinated.length > 0) {
    const unfinished = coordinated.filter((r) => outcomeOf(s, r.id) === 'running')
    const run = latest(unfinished.length > 0 ? unfinished : coordinated.filter((r) => coordinating(s, r, t)), (r) => Date.parse(r.createdAt))
    return run ? { coordinatorOf: run.id } : null
  }
  if (last === null) return null
  if ('dispatchId' in last) {
    const x = s.dispatches.find((d) => d.id === last.dispatchId)
    return x && held(x, t) ? last : null
  }
  const run = s.runs.find((r) => r.id === last.coordinatorOf)
  return run && coordinating(s, run, t) ? last : null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** A file followed from its end less TAIL_CAP, and again so when it gets shorter (made again), never read whole; a cut
 *  first line does not parse and is passed by the readers. The session's reader goes on across such a restart, so a
 *  response met again is not counted again (fix round 1, ruling 1). */
const follow = async (file: string): Promise<JsonlTail> => {
  const size = await fs.stat(file).then(
    (st) => st.size,
    () => 0
  )
  return new JsonlTail(file, { offset: Math.max(0, size - TAIL_CAP), restartWithin: TAIL_CAP })
}

type Listen<A extends unknown[]> = (cb: (...a: A) => void) => () => void

/** One session followed: its rollout (Codex), its transcript files (Claude terminal), or its process lines (Claude
 *  chat, read as they come). */
interface Followed {
  sessionId: string
  since: number
  rollout: { path: string; tail: JsonlTail | null; read: (lines: readonly string[]) => TokensSpent[] } | null
  /** Claude terminal: one reader over the transcript and its sub-agents' files, by path, and every sub-agent file looked
   *  at, followed or not. Null for a Codex session. */
  transcript: { read: (lines: readonly string[]) => TokensSpent[]; files: Map<string, JsonlTail>; seen: Set<string> } | null
  chat: ((lines: readonly string[]) => TokensSpent[]) | null
  /** When its pty or process ended (epoch ms), null while it runs. Its last read takes nothing dated after it. */
  endedAt: number | null
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
  /** `tokenOwnerOf` over the state now; `last` is the owner the session's earlier responses had. */
  ownerOf(sessionId: string, at: string, last: TokenOwner | null): TokenOwner | null
  log(message: string): void
  /** Test injection (epoch ms). */
  now?: () => number
  /** Test injection: how the files are read again; returns the stop. */
  every?: (ms: number, fn: () => void) => () => void
}): TokenSources {
  const now = d.now ?? Date.now
  /** The owner each session last had, for its lines read after the state stopped naming it. */
  const lastOwner = new Map<string, TokenOwner>()
  const hand = (f: Followed, spent: TokensSpent[]): void => {
    for (const x of spent) {
      const at = x.at ?? new Date(now()).toISOString()
      // An ended session's file can be written on by the next one (a roll onto the same account copies nothing, a Codex
      // chat resumes into its own rollout): what is dated after the end is that one's (fix round 1, I1)
      if (f.endedAt !== null && !(Date.parse(at) <= f.endedAt)) continue
      const owner = d.ownerOf(f.sessionId, at, lastOwner.get(f.sessionId) ?? null)
      if (!owner) continue
      lastOwner.set(f.sessionId, owner)
      d.store.add(f.sessionId, owner, x)
    }
  }

  /** Followed sessions: a terminal by its pty id, a chat by its process id. */
  const terminals = new Map<string, Followed>()
  const chats = new Map<string, Followed>()
  const fresh = (sessionId: string): Followed => ({ sessionId, since: now(), rollout: null, transcript: null, chat: null, endedAt: null })
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
        f.transcript = { read: claudeTokenReader(f.since), files: new Map(), seen: new Set() }
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
      } else f.endedAt = now()
    })
  ]

  /** Reads `tail` forward and hands what it spent; true when lines came. */
  const readTail = async (f: Followed, tail: JsonlTail, read: (lines: readonly string[]) => TokensSpent[]): Promise<boolean> => {
    const got = await tail.read()
    if (!got || got.lines.length === 0) return false
    hand(f, read(got.lines))
    return true
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
      let main = t.files.get(named)
      if (!main) t.files.set(named, (main = await follow(named)))
      const grew = await readTail(f, main, t.read)
      // A sub-agent writes a file of its own beside the transcript, made when it starts. One last written before this
      // session started is a session before's, in a resumed conversation's folder (fix round 1, ruling 2): not
      // followed. Each file is looked at when the folder first lists it, not at every read (final review M3); one that
      // could not be looked at is tried again at the next. One passed by is looked at again only on a read where the
      // main transcript grew, as it does around a sub-agent's work: a sub-agent resumed in a resumed conversation writes
      // on in its own old file (deferred minor a), and the reader's message ids count what it holds once
      const agents = path.join(path.dirname(named), path.basename(named, '.jsonl'), 'subagents')
      const names = await fs.readdir(agents).catch(() => [] as string[])
      for (const n of names) {
        const file = path.join(agents, n)
        if (!n.endsWith('.jsonl') || t.files.has(file) || (t.seen.has(file) && !grew)) continue
        const written = await fs.stat(file).then(
          (st) => st.mtimeMs,
          () => null
        )
        if (written === null) continue
        t.seen.add(file)
        if (written >= f.since) t.files.set(file, await follow(file))
      }
    }
    for (const [file, tail] of t.files) if (file !== named) await readTail(f, tail, t.read)
  }

  /** Reads each of `followed` forward; one that had ended is read this last time and let go. */
  const readEach = async (followed: Map<string, Followed>): Promise<void> => {
    for (const [key, f] of [...followed]) {
      const last = f.endedAt !== null
      try {
        await readOne(f)
      } catch (err) {
        d.log(`tokens: the files of session ${f.sessionId} could not be read: ${String(err)}`)
      }
      if (!last) continue
      followed.delete(key)
      // Its readers go with it: the message ids it counted and the files it followed
      f.transcript = null
      f.rollout = null
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

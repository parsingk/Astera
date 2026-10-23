// Which agent profile a conversation ran as (Agent Profiles follow-up). A transcript does not record it, so resuming from
// history a conversation no tab holds any more started it without its profile: its excluded MCP servers came back. The
// app writes it down here when it learns the provider's own id for a session started from a profile (Claude's session
// id, a Codex thread id: what a history entry names), and the resume dialog reads it back. The app is the one writer,
// through one queue. A damaged file is kept aside and started afresh by the next record rather than refused: it holds a
// convenience, and a resume without it starts as a conversation without a profile does (design §5).
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { profilePaths } from '../profile/paths'
import { keepDamaged, readStoreFile } from '../storeFile'
import { writeThroughTmp } from '../accounts/fileQueue'
import { readAgentProfiles } from './store'

/** Conversations remembered, the most recently learned kept. A profile is picked for some sessions, not every one, and
 *  a history resume rarely reaches back past a few months: this covers that and keeps the file a few dozen kilobytes. */
export const PROFILE_CONVERSATIONS_MAX = 500

export interface ProfileConversationStore {
  version: 1
  /** By the provider's conversation id: the profile that ran it, and when that was learned. */
  conversations: Record<string, { agentProfileId: string; at: string }>
}

type Loaded = { kind: 'store'; store: ProfileConversationStore } | { kind: 'damaged'; text: string } | { kind: 'unreadable'; error: unknown }

const isStore = (v: unknown): v is ProfileConversationStore => {
  if (v === null || typeof v !== 'object') return false
  const s = v as { version?: unknown; conversations?: unknown }
  if (s.version !== 1 || s.conversations === null || typeof s.conversations !== 'object' || Array.isArray(s.conversations)) return false
  return Object.values(s.conversations).every(
    (e) => e !== null && typeof e === 'object' && typeof (e as { agentProfileId?: unknown }).agentProfileId === 'string' && typeof (e as { at?: unknown }).at === 'string'
  )
}

async function load(file: string): Promise<Loaded> {
  const read = await readStoreFile(file)
  if (read.kind === 'missing') return { kind: 'store', store: { version: 1, conversations: {} } }
  if (read.kind === 'unreadable') return read
  let parsed: unknown
  try {
    parsed = JSON.parse(read.text)
  } catch {
    parsed = null
  }
  return isStore(parsed) ? { kind: 'store', store: parsed } : { kind: 'damaged', text: read.text }
}

/** The newest `PROFILE_CONVERSATIONS_MAX` by when they were learned. */
function newest(conversations: ProfileConversationStore['conversations']): ProfileConversationStore['conversations'] {
  const entries = Object.entries(conversations)
  if (entries.length <= PROFILE_CONVERSATIONS_MAX) return conversations
  entries.sort(([, a], [, b]) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  return Object.fromEntries(entries.slice(0, PROFILE_CONVERSATIONS_MAX))
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export interface ProfileConversations {
  /** A session started from `agentProfileId` is on `conversationId`. Written unless this process already wrote that pair
   *  (every hook event of a Claude session names its conversation); one attempt per pair, a failure logged. Never
   *  rejects: it must not disturb the event that learned the id, and nothing waits on it. */
  record(conversationId: string, agentProfileId: string): Promise<void>
  /** A session learned its conversation id (a Claude hook payload, a Codex rollout's thread, a chat's `ready`): recorded
   *  with the profile the session runs as, nothing for a session without one or an id not learned yet. */
  learned(sessionId: string, conversationId: string | null | undefined): Promise<void>
  /** The profile a conversation ran as, while the profile store still has that profile (archived too: work that holds
   *  one keeps resolving it, design §4). Null when none was recorded, the profile is gone, or either file cannot be
   *  read: the resume then starts without one (design §5). Never rejects. */
  profileOf(conversationId: string): Promise<string | null>
}

export function profileConversations(d: {
  profileDir: string
  now?: () => number
  log: (line: string) => void
  /** The profile a live session of this app runs as (SessionInfo.agentProfileId), terminal or chat. */
  profileOfSession: (sessionId: string) => string | undefined
}): ProfileConversations {
  const file = profilePaths(d.profileDir).agentProfileConversations
  const now = d.now ?? Date.now
  /** The pairs this process wrote (or tried to): conversation id → profile id. */
  const written = new Map<string, string>()
  // One write at a time: each reads what the one before it wrote
  let chain: Promise<unknown> = Promise.resolve()
  const queued = (f: () => Promise<void>): Promise<void> => {
    const run = chain.then(f, f)
    chain = run.catch(() => {})
    return run
  }

  const record = (conversationId: string, agentProfileId: string): Promise<void> => {
    if (written.get(conversationId) === agentProfileId) return Promise.resolve()
    written.set(conversationId, agentProfileId)
    return queued(async () => {
      try {
        const loaded = await load(file)
        // Nothing read, nothing written over (audit U-1)
        if (loaded.kind === 'unreadable') throw loaded.error
        if (loaded.kind === 'damaged') {
          await keepDamaged(file, loaded.text)
          d.log(`agent profiles: ${path.basename(file)} was damaged; a copy was kept beside it and it starts afresh`)
        }
        const before = loaded.kind === 'store' ? loaded.store.conversations : {}
        const conversations = newest({ ...before, [conversationId]: { agentProfileId, at: new Date(now()).toISOString() } })
        await fs.mkdir(path.dirname(file), { recursive: true })
        await writeThroughTmp(file, JSON.stringify({ version: 1, conversations } satisfies ProfileConversationStore, null, 2) + '\n')
      } catch (e) {
        d.log(`agent profiles: could not record that conversation ${conversationId} ran as ${agentProfileId} (${message(e)})`)
      }
    })
  }

  return {
    record,
    learned: (sessionId, conversationId) => {
      if (!conversationId) return Promise.resolve()
      const agentProfileId = d.profileOfSession(sessionId)
      return agentProfileId === undefined ? Promise.resolve() : record(conversationId, agentProfileId)
    },
    profileOf: async (conversationId) => {
      const loaded = await load(file)
      if (loaded.kind !== 'store' || !Object.hasOwn(loaded.store.conversations, conversationId)) return null
      const { agentProfileId } = loaded.store.conversations[conversationId]
      try {
        return (await readAgentProfiles(d.profileDir)).profiles.some((p) => p.id === agentProfileId) ? agentProfileId : null
      } catch {
        return null
      }
    }
  }
}

// The tokens each session spent, and for whom (observe mode design §10): a worker's for its Dispatch, a coordinator's
// for its Run. The Host keeps them in memory and in <profile>/token-totals.json, so a Host restart keeps the totals of
// sessions it no longer holds; `runs get` and `tasks get` add them up (core/orchestration/publicViews.ts). Written in
// every mode, by the Host alone, and only once a session of some Run has spent something.
//
// One entry per session and owner, each what that session itself spent: a roll's new session is an entry of its own
// beside the old one, and neither holds the other's tokens (sources.ts reads each from its own start to its end), so a
// Dispatch's entries add up without counting anything twice (Review Focus 5).
//
// Pruned with the Runs (the orchestration's Run TTL, store.ts RUN_TTL_MS, or a Run a person deleted): an entry whose
// Dispatch or Run the state no longer holds is dropped at the next save. Never while the state is not in memory: an
// empty state then says nothing. A damaged file is kept aside and started afresh, as the agent profile conversations
// are (it holds figures, not a person's settings); one that cannot be read is not written over (audit U-1), and the
// figures stay in memory until it can be.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { profilePaths } from '../../core/profile/paths'
import { keepDamaged, readStoreFile } from '../../core/storeFile'
import { writeThroughTmp } from '../../core/accounts/fileQueue'
import type { OrchState } from '../../core/orchestration/state'
import type { SpentTokens } from '../../core/orchestration/publicViews'

/** Whom a session's tokens were spent for. */
export type TokenOwner = { dispatchId: string } | { coordinatorOf: string }

interface TokenTotalsFile {
  version: 1
  spent: SpentTokens[]
}

const count = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0
const text = (v: unknown): boolean => typeof v === 'string' && v !== ''
const isEntry = (v: unknown): v is SpentTokens => {
  if (v === null || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  return text(e.sessionId) && (text(e.dispatchId) || text(e.coordinatorOf)) && count(e.input) && count(e.output)
}
const isFile = (v: unknown): v is TokenTotalsFile =>
  v !== null && typeof v === 'object' && (v as { version?: unknown }).version === 1 && Array.isArray((v as { spent?: unknown }).spent) && (v as TokenTotalsFile).spent.every(isEntry)

const keyOf = (e: { sessionId: string; dispatchId?: string; coordinatorOf?: string }): string =>
  e.dispatchId !== undefined ? `${e.sessionId}|dispatch|${e.dispatchId}` : `${e.sessionId}|run|${e.coordinatorOf}`

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export interface TokenStore {
  /** `spent` more for `owner` by `sessionId`. Nothing for a spend of nothing. */
  add(sessionId: string, owner: TokenOwner, spent: { input: number; output: number }): void
  /** Every entry, in the order first heard. */
  spent(): SpentTokens[]
  /** Prunes against the state and writes when anything changed. One at a time; never rejects. */
  save(): Promise<void>
}

export async function openTokenStore(d: {
  profileDir: string
  /** The orchestration state, or null while it is not in memory (then nothing is pruned). */
  state: () => OrchState | null
  log: (line: string) => void
}): Promise<TokenStore> {
  const file = profilePaths(d.profileDir).tokenTotals
  const entries = new Map<string, SpentTokens>()
  let loaded = false
  let dirty = false
  /** Said once: every save tries the read again while it fails. */
  let unreadSaid = false

  const merge = (e: SpentTokens): void => {
    const k = keyOf(e)
    const had = entries.get(k)
    if (had) {
      had.input += e.input
      had.output += e.output
    } else entries.set(k, { ...e })
  }

  /** Reads the file, what memory already holds added on top. Leaves `loaded` false when it cannot be read. */
  const load = async (): Promise<void> => {
    const read = await readStoreFile(file)
    if (read.kind === 'unreadable') {
      if (!unreadSaid) d.log(`tokens: ${path.basename(file)} could not be read (${message(read.error)}); the totals stay in memory until it can`)
      unreadSaid = true
      return
    }
    loaded = true
    if (read.kind === 'missing') return
    let parsed: unknown = null
    try {
      parsed = JSON.parse(read.text)
    } catch {
      parsed = null
    }
    if (!isFile(parsed)) {
      await keepDamaged(file, read.text)
      d.log(`tokens: ${path.basename(file)} was damaged; a copy was kept beside it and it starts afresh`)
      // Written clean at the next save, so the next Host does not keep another copy of the same damage
      dirty = true
      return
    }
    const heldBefore = [...entries.values()]
    entries.clear()
    for (const e of parsed.spent) merge(e)
    for (const e of heldBefore) merge(e)
  }

  const prune = (s: OrchState): void => {
    const dispatches = new Set(s.dispatches.map((x) => x.id))
    const runs = new Set(s.runs.map((r) => r.id))
    for (const [k, e] of entries) {
      const kept = e.dispatchId !== undefined ? dispatches.has(e.dispatchId) : e.coordinatorOf !== undefined && runs.has(e.coordinatorOf)
      if (!kept) {
        entries.delete(k)
        dirty = true
      }
    }
  }

  let chain: Promise<unknown> = Promise.resolve()
  const queued = (f: () => Promise<void>): Promise<void> => {
    const run = chain.then(f, f)
    chain = run.catch(() => {})
    return run
  }

  await load()

  return {
    add(sessionId, owner, spent) {
      if (!(spent.input + spent.output > 0)) return
      merge({ sessionId, ...owner, input: spent.input, output: spent.output })
      dirty = true
    },
    spent: () => [...entries.values()].map((e) => ({ ...e })),
    save: () =>
      queued(async () => {
        try {
          if (!loaded) await load()
          if (!loaded) return
          const s = d.state()
          if (s) prune(s)
          if (!dirty) return
          dirty = false
          await fs.mkdir(path.dirname(file), { recursive: true })
          await writeThroughTmp(file, JSON.stringify({ version: 1, spent: [...entries.values()] } satisfies TokenTotalsFile, null, 2) + '\n')
        } catch (e) {
          dirty = true
          d.log(`tokens: ${path.basename(file)} could not be written (${message(e)})`)
        }
      })
  }
}

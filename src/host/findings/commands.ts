// The Host's `agent-profiles-audit*` commands (lifecycle design §6, §7, §8): the findings, computed on request from the
// files and the state this Host already holds, and the ignore file. The Host gathers every input here, each source in a
// try of its own, so a source it cannot read leaves its field undefined, is logged once naming it, and drops only the
// findings that need it (§8, Review Focus 1); the rules themselves are pure (core/findings/compute.ts). One report is
// kept for a minute, so the section, the profile marks and the CLI asking together read the disk once (§8, Review Focus 5).
// Nothing here acts on a finding (§1, §9), and the ignore list is the one thing these commands change for the person. A
// compute also writes what the readers it calls write as they read: the history stamp the first time
// (`findings-history.json`, since.ts), the copy a store reader keeps beside a damaged file, and the orphaned token files
// opening the Runtime registry removes (core/runtimes/registry.ts); the Host's wiring loads the orchestration state as
// every command does (index.ts).
//
// The app and this machine's CLI may read and change the ignores. An agent's shell may read the findings, as it may read
// the Credentials list: they hold names and ids only (§8). It is refused the ignores, so an agent cannot hide a finding
// about itself. MCP clients and plugins have none of the three (§7).
import { RepairNeeded } from '../../core/settings/repairNeeded'
import type { OrchCaller } from '../../core/host/orchProtocol'
import type { Account } from '../../core/types'
import type { OrchState } from '../../core/orchestration/state'
import type { SpentTokens } from '../../core/orchestration/publicViews'
import type { RuntimeProfile } from '../../core/runtimes/registry'
import { readAgentProfiles } from '../../core/agentProfiles/store'
import { readAuditPolicy } from '../../core/audit/policy'
import { auditDayOf, auditStoppedDays, stoppedDaysIn, visitRecords } from '../../core/audit/store'
import { summarizeExtensionUses } from '../../core/audit/extensionUses'
import { readExtensionRegistry } from '../../core/extensions/registry'
import { readExtensionCopies } from '../../core/extensions/copies'
import { ownMcpNames } from '../../core/extensions/discover'
import { readCredentials } from '../../core/credentials/store'
import { latestUsesSince } from '../../core/credentials/uses'
import { profilePaths } from '../../core/profile/paths'
import { computeFindings, type FindingInputs } from '../../core/findings/compute'
import { readIgnored, writeIgnored, type IgnoredFile } from '../../core/findings/ignored'
import { readFindingsSince } from '../../core/findings/since'
import { DAY_MS, OBSERVE_WINDOW_DAYS, observeHistory } from '../../core/findings/history'
import { emptyUse, addRecord } from '../../core/findings/usage'
import type { FindingSource, FindingsReport } from '../../core/findings/types'

export const FINDINGS_COMMANDS: ReadonlySet<string> = new Set(['agent-profiles-audit', 'agent-profiles-audit-ignore', 'agent-profiles-audit-unignore'])

/** The two that change the ignore file: refused to an agent's shell. */
const FINDINGS_CHANGES: ReadonlySet<string> = new Set(['agent-profiles-audit-ignore', 'agent-profiles-audit-unignore'])

/** How long one report answers every request (plan thresholds: the Host cache), counted from its `computedAt`. */
export const FINDINGS_CACHE_MS = 60_000

/** The longest note an ignore keeps, as the archive reason (lifecycle ruling 12): one line, shown beside the finding. */
const NOTE_MAX = 200

export interface FindingsAnswer {
  status: number
  body: unknown
}

export interface HostFindings {
  command(a: {
    cmd: string
    args: Record<string, unknown>
    role: OrchCaller['role'] | undefined
    /** The sentence an agent's shell is refused with, present exactly when the caller is one. */
    agentRefusal?: string
    marks: { effects: number }
  }): Promise<FindingsAnswer>
  /** Drops the report kept for the minute (ruling R8-1): the Host calls it after any command that changed something (an
   *  archive, an edit, a rule, an ignore), so the next request computes from what is there now. */
  forget(): void
}

/** What the Host reads besides the profile's own files (lifecycle design §3, §8). */
export interface FindingsDeps {
  profileDir: string
  /** Where a Claude account kept in the home folder has its `.claude.json` (extensions/discover.ts ownMcpNames). */
  homeDir: string
  platform?: NodeJS.Platform
  /** Test injection for the clock (epoch ms). */
  nowMs?: () => number
  /** The orchestration state, loaded as every command loads it; null when there is none to read. */
  orchState(): OrchState | null | Promise<OrchState | null>
  /** What each session spent for a Dispatch or a Run's coordinator (the token store). */
  spent(): readonly SpentTokens[]
  /** The app-wide "Run agents without permission checks" setting (app-settings.json), for a profile that inherits it. */
  appBypass(): Promise<boolean>
  readAccounts(): Promise<Account[]>
  /** The paired Runtimes of this machine (core/runtimes/registry.ts). */
  openRuntimes(): Promise<RuntimeProfile[]>
  /** The Claude Code on this machine, from the Host's version probe after a warm; null when it is not there or its
   *  version could not be read. */
  claudeVersion(): Promise<string | null>
  log(line: string): void
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const bad = (error: string): FindingsAnswer => ({ status: 400, body: { error } })

/** Whether a day in the window, by local day, stopped at the size: its log holds fewer uses than were made. */
const stoppedInWindow = (days: readonly string[], sinceMs: number, nowMs: number): boolean => {
  const first = auditDayOf(new Date(sinceMs).toISOString())
  const last = auditDayOf(new Date(nowMs).toISOString())
  return days.some((d) => d >= first && d <= last)
}

/** Throws when a day of the window in this use log's folder stopped at the size (rulings R4-4, R6-7): its uses are
 *  missing data, so the log is read as unread rather than as complete. */
const refuseStoppedWindow = (folder: string, sinceMs: number, nowMs: number): void => {
  if (stoppedInWindow(stoppedDaysIn(folder), sinceMs, nowMs)) throw new Error('a day of the last 30 stopped recording at the size limit')
}

/**
 * Every input of the findings at `nowMs`, each source read in its own try (§8): one that throws is left undefined, which
 * computeFindings reads as unread, and is logged once naming it. `ignored` is null when the ignore file could not be read,
 * and every finding then shows as open. Exported for the tests that look at what was gathered.
 */
export async function gatherFindings(d: FindingsDeps, nowMs: number): Promise<{ inputs: FindingInputs; ignored: IgnoredFile | null }> {
  const dir = d.profileDir
  const sinceMs = nowMs - OBSERVE_WINDOW_DAYS * DAY_MS
  const since = new Date(sinceMs).toISOString()
  const read = async <T>(source: FindingSource, f: () => T | Promise<T>): Promise<T | undefined> => {
    try {
      return await f()
    } catch (e) {
      // A parse error can quote the text it read (runtimes.json, say): the log says only that it did not parse
      d.log(`findings: ${source} could not be read (${e instanceof SyntaxError ? 'it did not parse' : message(e)})`)
      return undefined
    }
  }
  // Never rejects: a stamp it cannot keep counts from now, which ages nothing (since.ts)
  const findingsSince = await readFindingsSince(dir, nowMs, { log: d.log })

  const [profiles, accounts, orch, spent, policy, observed, registry, credentials, credentialLastUse, runtimes, claudeVersion, appBypass, ignored] =
    await Promise.all([
      read('profiles', async () => (await readAgentProfiles(dir)).profiles),
      read('accounts', () => d.readAccounts()),
      read('orchestration', async () => {
        const s = await d.orchState()
        if (s === null) throw new Error('this Host holds no orchestration state')
        return s
      }),
      read('tokens', () => d.spent()),
      // The copy of a damaged file is the policies commands' to keep, as the recorder reads it
      read('policy', () => readAuditPolicy(dir, { keepDamaged: false })),
      // Streamed once into the summary: no record is kept (Review Focus 5)
      read('records', async () => {
        const u = emptyUse()
        await visitRecords(dir, { since }, (r) => void addRecord(u, r), { now: () => nowMs })
        return u
      }),
      read('extensions', async () => (await readExtensionRegistry(dir)).entries),
      read('credentials', () => readCredentials(dir)),
      read('credential-uses', async () => {
        refuseStoppedWindow(profilePaths(dir).credentialUses, sinceMs, nowMs)
        return latestUsesSince(dir, sinceMs, nowMs)
      }),
      read('runtimes', () => d.openRuntimes()),
      read('cli-version', () => d.claudeVersion()),
      read('settings', () => d.appBypass()),
      readIgnored(dir).catch((e: unknown) => {
        d.log(`findings: ignored could not be read (${message(e)})`)
        return null
      })
    ])

  // An account's own MCP servers are read only for the accounts there are: with none read, there is nothing to ask, and
  // every rule that reads them needs the accounts too, which `unread` names already
  const accountMcpNames =
    accounts === undefined
      ? new Map<string, ReadonlySet<string>>()
      : await read('account-mcp', async () => {
          const names = new Map<string, ReadonlySet<string>>()
          for (const a of accounts) {
            try {
              names.set(a.id, await ownMcpNames(a, d.homeDir))
            } catch (e) {
              // A parse error can quote the file, which may hold a secret: the log gets the account and the error's code
              const code = (e as NodeJS.ErrnoException | null)?.code
              throw new Error(`the configuration of account ${a.id} ${typeof code === 'string' ? `could not be read (${code})` : 'did not parse'}`)
            }
          }
          return names
        })
  // The canonical copies are read only to place a use (§4.12): with no registry there is none, and the rule that reads
  // them needs the registry too
  const uses = await read('extension-uses', async () => {
    refuseStoppedWindow(profilePaths(dir).extensionUses, sinceMs, nowMs)
    const summary = await summarizeExtensionUses(dir, sinceMs, nowMs)
    return { summary, copies: registry === undefined ? new Map() : await readExtensionCopies(dir, registry) }
  })
  // When the rules file is unread so is the history, which the report then does not claim (FindingsReport.observe)
  const observe = policy === undefined ? undefined : observeHistory({ policy, findingsSince, stoppedDays: auditStoppedDays(dir), nowMs })

  return {
    inputs: {
      nowMs,
      platform: d.platform ?? process.platform,
      findingsSince,
      profiles,
      accounts,
      appBypass,
      orch,
      spent,
      policy,
      observed,
      observe,
      registry,
      accountMcpNames,
      credentials,
      credentialLastUse,
      runtimes,
      extensionUses: uses?.summary,
      extensionCopies: uses?.copies,
      claudeVersion
    },
    ignored
  }
}

/** A note as given: absent, or one line of at most NOTE_MAX characters once trimmed, blank being none. Anything else is
 *  refused rather than cut, so what is kept is what the person wrote. */
function noteArg(v: unknown): { ok: true; text?: string } | { ok: false; error: string } {
  if (v === undefined) return { ok: true }
  if (typeof v !== 'string' || /[\r\n]/.test(v)) return { ok: false, error: 'note must be one line of text' }
  const text = v.trim()
  if (text.length > NOTE_MAX) return { ok: false, error: `note must be at most ${NOTE_MAX} characters` }
  return text === '' ? { ok: true } : { ok: true, text }
}

const keyArg = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

export function createHostFindings(d: FindingsDeps): HostFindings {
  const nowMs = d.nowMs ?? Date.now
  // One ignore change at a time: two must each read what the other wrote
  let chain: Promise<unknown> = Promise.resolve()
  const queued = <T>(f: () => Promise<T>): Promise<T> => {
    const run = chain.then(f, f)
    chain = run.catch(() => {})
    return run
  }

  /** The report every request reads for a minute, with every finding, ignored ones marked. */
  let cache: { report: FindingsReport; atMs: number } | null = null
  /** A compute under way, which a request arriving meanwhile shares, unless an ignore change came after it started. */
  let computing: { generation: number; run: Promise<FindingsReport> } | null = null
  /** Counts the ignore changes: a compute that began before one is not kept, nor shared after it. */
  let generation = 0

  const compute = async (atMs: number): Promise<FindingsReport> => {
    const { inputs, ignored } = await gatherFindings(d, atMs)
    // A rule that throws costs its own findings, logged here (ruling R7-1)
    const report = computeFindings(inputs, ignored ?? { version: 1, ignored: {} }, d.log)
    // The ignore file is no rule's source (compute.ts RuleSource): named here, after the others, when it was unread
    return ignored === null ? { ...report, unread: [...report.unread, 'ignored'] } : report
  }

  const report = (): Promise<FindingsReport> => {
    const now = nowMs()
    if (cache !== null && now >= cache.atMs && now - cache.atMs < FINDINGS_CACHE_MS) return Promise.resolve(cache.report)
    if (computing !== null && computing.generation === generation) return computing.run
    const mine = generation
    const run = compute(now).then((r) => {
      if (generation === mine) cache = { report: r, atMs: now }
      return r
    })
    const entry = { generation: mine, run }
    computing = entry
    void run.then(
      () => {
        if (computing === entry) computing = null
      },
      () => {
        if (computing === entry) computing = null
      }
    )
    return run
  }

  /** After a change, an ignore or any other (HostFindings.forget): the next request computes afresh, and a compute under
   *  way is no longer shared. */
  const forget = (): void => {
    cache = null
    generation += 1
  }

  const answer = async (cmd: string, args: Record<string, unknown>): Promise<FindingsAnswer> => {
    switch (cmd) {
      case 'agent-profiles-audit': {
        if (args.all !== undefined && typeof args.all !== 'boolean') return bad('all must be true or false')
        const r = await report()
        return { status: 200, body: args.all === true ? r : { ...r, findings: r.findings.filter((f) => !f.ignored) } }
      }
      case 'agent-profiles-audit-ignore': {
        const key = keyArg(args.key)
        if (key === null) return bad('agent-profiles-audit-ignore needs the key of a finding')
        const note = noteArg(args.note)
        if (!note.ok) return bad(note.error)
        return queued(async () => {
          // Only a finding there is now can be set aside: a key typed wrong must not sit in the file hiding nothing
          if (!(await report()).findings.some((f) => f.key === key)) return { status: 404, body: { error: `no current finding has the key ${key}` } }
          const file = await readIgnored(d.profileDir)
          const entry = { at: new Date(nowMs()).toISOString(), ...(note.text !== undefined ? { note: note.text } : {}) }
          await writeIgnored(d.profileDir, { version: 1, ignored: { ...file.ignored, [key]: entry } })
          forget()
          return { status: 200, body: { key } }
        })
      }
      case 'agent-profiles-audit-unignore': {
        const key = keyArg(args.key)
        if (key === null) return bad('agent-profiles-audit-unignore needs the key of a finding')
        return queued(async () => {
          const file = await readIgnored(d.profileDir)
          if (!Object.hasOwn(file.ignored, key)) return { status: 200, body: { key, removed: false } }
          const ignored = Object.fromEntries(Object.entries(file.ignored).filter(([k]) => k !== key))
          await writeIgnored(d.profileDir, { version: 1, ignored })
          forget()
          return { status: 200, body: { key, removed: true } }
        })
      }
      default:
        return { status: 501, body: { error: `${cmd} is not answered by this Host` } }
    }
  }

  return {
    forget,
    command: async (a) => {
      if (a.role !== 'app' && a.role !== 'cli') return { status: 403, body: { error: `${a.cmd} is for this machine's app and CLI only` } }
      if (FINDINGS_CHANGES.has(a.cmd) && a.agentRefusal !== undefined) return { status: 403, body: { error: a.agentRefusal } }
      let r: FindingsAnswer
      try {
        r = await answer(a.cmd, a.args)
      } catch (e) {
        // A damaged ignore file is the person's to repair (its copy was kept beside it); anything else failed
        r = { status: e instanceof RepairNeeded ? 409 : 500, body: { error: message(e) } }
      }
      // A change that landed: an ignore written, or one brought back. Reading changes nothing
      if (r.status === 200 && FINDINGS_CHANGES.has(a.cmd) && (r.body as { removed?: boolean }).removed !== false) a.marks.effects += 1
      return r
    }
  }
}

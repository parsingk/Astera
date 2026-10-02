// How It Works in the Host (E1 §2, §3): the core store over <profile>/understanding.json and the core
// pipeline, run by the Host so a finished Run is recorded and a record regenerated with no Astera window
// open. **Only while this Host is the one writer**: every attached app yields `understanding`, or none is
// attached (`!server.appsKeep(HOST_YIELD_UNDERSTANDING)`), read at every entry and again at every store
// write, as the journal's gate is (hostJournal.ts). An app that keeps the duty writes the file itself, and
// the Host then writes nothing. **A generation in flight when the writer flips still runs its agent to the
// end and then drops its result**: the record stays as the writer last saw it. And since the two can be
// the writer in turn, every Host write starts from the file, not from memory (the pipeline's
// store.refresh before each prepend and patch), so an app's records written meanwhile survive.
//
// What the app supplies from its own state, the Host reads here: the accounts per call, the generator
// settings and the language from one read of app-settings.json per call (the app's own keys: `generator`,
// `lang`), and the key folding with repoPathOf over the Host's own worktree registry, as the app folds
// over its own (ipc.ts understandingKeyOf). **No tracking gate on Runs** (ruling 9): the app never gated
// Run records on its tracking toggle, which gates session units, and the toggle defaults off.
//
// Imports nothing from electron, src/main or src/renderer (importFence.test.ts).
import path from 'node:path'
import type { Account, Provider, WorktreeInfo } from '../core/types'
import type { ProviderDescriptor } from '../core/providers/descriptor'
import type { ProjectUnderstanding, WorkRecord } from '../core/understanding/types'
import type { SessionWorkUnit } from '../core/workUnit/types'
import { UnderstandingStore } from '../core/understanding/store'
import { UnderstandingPipeline, type PipelineDeps, type RunRecordInput } from '../core/understanding/pipeline'
import { readGeneratorSettings, type GeneratorSettings } from '../core/understanding/generatorSettings'
import { settingsObjectOf } from '../core/settings/settingsObject'
import { RepairNeeded } from '../core/settings/repairNeeded'
import { readFileRetrying } from '../core/renameRetry'
import { readAccountEntries } from '../core/accounts/accountsFile'
import { repoPathOf } from '../core/worktrees/repo'
import { isSamePath } from '../core/files/tree'
import { isLang, type Lang } from '../core/i18n'
import { pickInitialLang } from '../core/i18n/locale'

/** The refusal while an attached app keeps the duty (E1 §5): that app writes the records, so a regenerate
 *  belongs there. */
export const NOT_WRITER = 'an older Astera app is writing How It Works records; regenerate there'

export interface UnderstandingSettings {
  generator: GeneratorSettings
  lang: Lang
}

/** The OS locale as node reports it, the app's fallback for a file with no `lang` (checks.ts osLang). */
const osLang = (): Lang => pickInitialLang(Intl.DateTimeFormat().resolvedOptions().locale)

/** One read of app-settings.json. No file is the app's defaults (no generator, the OS locale); a file
 *  that cannot be read or is not a settings object **throws**: the generator cannot be known, and the
 *  caller records nothing rather than guess (E1 error handling). The language follows checks.ts'
 *  lang(): the file's `lang` when it is one, the OS locale otherwise. */
export async function readUnderstandingSettings(settingsPath: string): Promise<UnderstandingSettings> {
  let text: string | null
  try {
    // Retried while the app's rename-replace holds the file (EBUSY/EPERM on win32), as checks.ts' lang()
    // reads it: a Run that finishes during a settings save is still recorded.
    text = await readFileRetrying(settingsPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    text = null
  }
  let o: Record<string, unknown> | null = null
  if (text !== null) {
    try {
      o = settingsObjectOf(text)
    } catch {
      // A fixed sentence, as readAppSettingsObject's: a JSON.parse message can quote the file, and this
      // one reaches MCP clients in regenerate's 500.
      throw new RepairNeeded('app-settings.json is not a valid settings file; open Astera to repair it', 'app-settings.json')
    }
  }
  const lang = o?.lang
  return {
    generator: readGeneratorSettings(o?.generator),
    lang: isLang(lang) ? lang : osLang()
  }
}

export interface HostUnderstandingDeps {
  /** <profile>/understanding.json */
  file: string
  profileDir: string
  /** true while every attached app yields `understanding`, or none is attached. */
  writer(): boolean
  /** Read per call. Defaults to <profileDir>/accounts.json, read with readFileRetrying. */
  accounts?(): Account[] | Promise<Account[]>
  descriptors: Record<Provider, ProviderDescriptor>
  /** Read per call. Defaults to readUnderstandingSettings over <profileDir>/app-settings.json. */
  settings?(): Promise<UnderstandingSettings>
  /** The Host worktree registry's entries, from memory: a worktree folds onto the repository it came from. */
  worktrees(): WorktreeInfo[]
  /** Commit subjects in a range, the pipeline's material for a session unit. */
  readCommits?: PipelineDeps['readCommits']
  log(m: string): void
  /** A write landed for this (folded) root: index.ts sends `understanding-state` to the apps. */
  push(root: string): void
  /** Test seam: the agent round trip. */
  runAgent?: PipelineDeps['runAgent']
  /** Test seam: the clock of `generatedAt`. */
  now?(): string
  /** Test seam: the platform whose path rule matches a project's key (isSamePath). */
  platform?: string
}

export interface HostUnderstanding {
  /** Once, at Host start, writer or not: the store's load, which marks a record left `generating` as
   *  failed/INTERRUPTED (its agent was a child of the Host that died), saved at once when this Host is
   *  the writer and otherwise kept for writerMayHaveChanged. Never rejects. */
  load(): Promise<void>
  /** Who writes may have changed (the server's `onAppsChanged`, and once the server listens): an
   *  interruption load marked but could not save is saved now, when this Host is the writer. Over a file
   *  another process wrote since, only the records load marked that are still `generating` there. Owed
   *  until the write lands. Never rejects. */
  writerMayHaveChanged(): Promise<void>
  /** A Run finished (E1 §3): recorded when this Host writes. Resolves once the record
   *  is queued, never waits on the agent. Never rejects. */
  onRunFinished(input: RunRecordInput & { projectPath: string }): Promise<void>
  /** A session unit the app's collector closed (`understanding-unit`). */
  onUnitClosed(projectPath: string, unit: SessionWorkUnit): Promise<{ ok: boolean; reason?: string }>
  /** [다시] or `regenerate_work_record` (`understanding-regenerate`): answers at once with the record's id. */
  regenerate(
    projectPath: string,
    recordId: string
  ): Promise<{ ok: true; id: string } | { ok: false; status: number; error: string }>
  isWriter(): boolean
  /** Test seam: resolves once every generation queued so far and every save have landed. Never rejects. */
  settled(): Promise<void>
}

/** The core store with the writer gate at every write, and the push after it. A write while an app keeps
 *  the duty is dropped whole, memory included, so what this Host holds stays what it last wrote. */
class GatedStore extends UnderstandingStore {
  constructor(
    filePath: string,
    private readonly may: () => boolean,
    private readonly wrote: (root: string) => void
  ) {
    super(filePath)
  }

  override async set(projectPath: string, value: ProjectUnderstanding): Promise<void> {
    await this.trySet(projectPath, value)
  }

  /** set, answering whether the write landed: false when the gate dropped it. */
  async trySet(projectPath: string, value: ProjectUnderstanding): Promise<boolean> {
    if (!this.may()) return false
    await super.set(projectPath, value)
    this.wrote(projectPath)
    return true
  }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createHostUnderstanding(d: HostUnderstandingDeps): HostUnderstanding {
  const settingsPath = path.join(d.profileDir, 'app-settings.json')
  const readSettings = d.settings ?? (() => readUnderstandingSettings(settingsPath))
  // Retried, as the settings are: a Run that finishes while the app's save holds accounts.json (EPERM on
  // win32) is still recorded with its generator account.
  const readAccounts = d.accounts ?? (() => readAccountEntries(path.join(d.profileDir, 'accounts.json'), readFileRetrying))

  const isWriter = (): boolean => {
    try {
      return d.writer()
    } catch (err) {
      d.log(`understanding: could not tell whether this Host writes How It Works records, so it does not: ${message(err)}`)
      return false
    }
  }

  const store = new GatedStore(
    d.file,
    () => {
      if (isWriter()) return true
      d.log('understanding: an attached app keeps How It Works now, a Host write is dropped')
      return false
    },
    (root) => {
      try {
        d.push(root)
      } catch (err) {
        d.log(`understanding-state could not be sent: ${message(err)}`)
      }
    }
  )

  /** The projects load marked interrupted in memory and no write has saved yet, and the records it
   *  marked (by id). Left `generating` in the file, the app (a reader) and MCP would show them spinning
   *  for good. A project leaves the list only once its write landed, or once the file says its marked
   *  records are no longer `generating`: a write the gate dropped (the writer flipped after the check
   *  below) is retried at the next change of writer. */
  let unsaved: string[] = []
  let interrupted = new Set<string>()
  /** Whether saveUnstuck has read another process's file since load. */
  let adopted = false
  const owed = (r: WorkRecord): boolean => r.status === 'generating' && interrupted.has(r.id)
  /** One at a time: two calls (the apps changing, the server listening) must not save twice. */
  let saving: Promise<void> = Promise.resolve()
  const saveUnstuck = (): Promise<void> => (saving = saving.then(saveUnstuckNow))
  const saveUnstuckNow = async (): Promise<void> => {
    if (unsaved.length === 0 || !isWriter()) return
    try {
      // Another process may have written the file since load, and then its file is the one read here. A
      // `generating` record in it that load did not mark may be that writer's own generation in flight
      // and is left alone; one load marked is still the dead Host's, and is marked again. Also when the
      // other write landed between load's stamp and its read (store.ts load), which this refresh reads
      // once more and adopts. Remembered: a save the gate dropped after an adoption is retried with the
      // file's records, and the next refresh no longer says it adopted them. Never adopted, memory holds
      // load's marks (and any generation this Host started since, which is not marked again).
      if (await store.refresh()) adopted = true
      for (const root of [...unsaved]) {
        const u = store.get(root)
        const again = adopted && u?.records.some(owed) === true
        if (!u || (adopted && !again)) {
          unsaved = unsaved.filter((k) => k !== root)
          continue
        }
        const next = again
          ? { ...u, records: u.records.map((r) => (owed(r) ? { ...r, status: 'failed' as const, reason: 'INTERRUPTED' } : r)) }
          : u
        if (await store.trySet(root, next)) unsaved = unsaved.filter((k) => k !== root)
      }
    } catch (err) {
      d.log(`understanding: the interrupted records could not be saved: ${message(err)}`)
    }
  }

  const loadStore = async (): Promise<void> => {
    try {
      const loaded = await store.load()
      if (loaded.recovered) d.log('understanding.json could not be read or parsed, kept the .bak and started empty')
      unsaved = loaded.unstuck
      interrupted = new Set(loaded.interrupted)
    } catch (err) {
      d.log(`understanding.json load failed: ${message(err)}`)
    }
    await saveUnstuck()
  }
  /** What the pipeline asks synchronously, as **the most recent call** read it: a generation queued
   *  behind others runs with the settings and accounts of the newest call, not of the call that queued it
   *  (the app's pipeline, too, reads them when the generation runs). */
  let current: { generator: GeneratorSettings; lang: Lang; accounts: Account[] } = { generator: {}, lang: osLang(), accounts: [] }
  /** Settings and accounts, read now; throws when either cannot be read. */
  const take = async (): Promise<UnderstandingSettings> => {
    const s = await readSettings()
    const accounts = await readAccounts()
    current = { generator: s.generator, lang: s.lang, accounts }
    return s
  }

  const pipeline = new UnderstandingPipeline({
    store,
    accountOf: (id) => current.accounts.find((a) => a.id === id) ?? null,
    descriptors: d.descriptors,
    generator: () => current.generator,
    lang: () => current.lang,
    now: d.now ?? (() => new Date().toISOString()),
    readCommits: d.readCommits,
    log: d.log,
    runAgent: d.runAgent
  })

  const fold = (projectPath: string): string => repoPathOf(d.worktrees(), projectPath)

  return {
    load: loadStore,
    writerMayHaveChanged: saveUnstuck,
    isWriter,
    settled: async () => {
      await saving
      await pipeline.settled()
      await store.settled()
    },
    onRunFinished: async (input) => {
      try {
        if (!isWriter()) return
        try {
          await take()
        } catch (err) {
          d.log(`understanding: app-settings.json or accounts.json could not be read, run ${input.runId} is not recorded: ${message(err)}`)
          return
        }
        const { projectPath, ...record } = input
        void pipeline.onRunFinished(fold(projectPath), record)
      } catch (err) {
        d.log(`understanding: recording run ${input.runId} failed: ${message(err)}`)
      }
    },
    onUnitClosed: async (projectPath, unit) => {
      if (!isWriter()) return { ok: false, reason: NOT_WRITER }
      try {
        await take()
      } catch (err) {
        d.log(`understanding: app-settings.json or accounts.json could not be read, a session unit is not recorded: ${message(err)}`)
        return { ok: false, reason: `the settings could not be read: ${message(err)}` }
      }
      void pipeline.onUnitClosed(fold(projectPath), unit)
      return { ok: true }
    },
    regenerate: async (projectPath, recordId) => {
      if (!isWriter()) return { ok: false, status: 409, error: NOT_WRITER }
      const folded = fold(projectPath)
      // The file's own spelling of the key, matched as the read tools match it (recordsFor): on win32 a
      // project id's path can differ from the key in case or separators.
      const keyOf = (): string => store.projectKeys().find((k) => isSamePath(k, folded, d.platform)) ?? folded
      // The record may be one an app wrote while it was the writer. Outside the pipeline's queue, so it
      // answers at once; refresh adopts no file over a write the pipeline made meanwhile.
      const known = (): boolean => store.get(keyOf())?.records.some((r) => r.id === recordId) === true
      await store.refresh()
      // Declined by such a write, the refresh read nothing, and an app's save may have landed after it:
      // once more before the answer is a 404.
      if (!known()) await store.refresh()
      if (!known())
        return { ok: false, status: 404, error: `no How It Works record ${recordId} in ${folded}` }
      const root = keyOf()
      try {
        await take()
      } catch (err) {
        d.log(`understanding: app-settings.json or accounts.json could not be read, record ${recordId} is not regenerated: ${message(err)}`)
        return { ok: false, status: 500, error: `the settings could not be read: ${message(err)}` }
      }
      // The answer says `generating`: the file says so first, since the fill may be queued behind another
      // generation. A write failure is logged, the fill still queued.
      try {
        await pipeline.markGenerating(root, recordId)
      } catch (err) {
        d.log(`understanding: record ${recordId} could not be marked generating: ${message(err)}`)
      }
      void pipeline.regenerate(root, recordId)
      return { ok: true, id: recordId }
    }
  }
}

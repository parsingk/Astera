// How It Works in the Host (E1 §2, §3): the core store over <profile>/understanding.json and the core
// pipeline, run by the Host so a finished Run is recorded and a record regenerated with no Astera window
// open. **Only while this Host is the one writer**: every attached app yields `understanding`, or none is
// attached (`!server.appsKeep(HOST_YIELD_UNDERSTANDING)`), read at every entry and again at every store
// write, as the journal's gate is (hostJournal.ts). An app that keeps the duty writes the file itself, and
// the Host then writes nothing.
//
// What the app supplies from its own state, the Host reads here: the accounts per call, the generator
// settings, the tracking toggle and the language from one read of app-settings.json per call (the app's own
// keys: `generator`, `workUnitTrackingEnabled`, `lang`), and the key folding with repoPathOf over the
// Host's own worktree registry, as the app folds over its own (ipc.ts understandingKeyOf).
//
// Imports nothing from electron, src/main or src/renderer (importFence.test.ts).
import path from 'node:path'
import type { Account, Provider, WorktreeInfo } from '../core/types'
import type { ProviderDescriptor } from '../core/providers/descriptor'
import type { ProjectUnderstanding } from '../core/understanding/types'
import type { SessionWorkUnit } from '../core/workUnit/types'
import { UnderstandingStore } from '../core/understanding/store'
import { UnderstandingPipeline, type PipelineDeps, type RunRecordInput } from '../core/understanding/pipeline'
import { readGeneratorSettings, type GeneratorSettings } from '../core/understanding/generatorSettings'
import { readAppSettingsObject } from '../core/settings/settingsObject'
import { repoPathOf } from '../core/worktrees/repo'
import { isLang, type Lang } from '../core/i18n'
import { pickInitialLang } from '../core/i18n/locale'

/** The refusal while an attached app keeps the duty (E1 §5): that app writes the records, so a regenerate
 *  belongs there. */
export const NOT_WRITER = 'an older Astera app is writing How It Works records; regenerate there'

export interface UnderstandingSettings {
  generator: GeneratorSettings
  /** The app's How It Works toggle: a finished Run is recorded only while it is on. */
  tracking: boolean
  lang: Lang
}

/** The OS locale as node reports it, the app's fallback for a file with no `lang` (checks.ts osLang). */
const osLang = (): Lang => pickInitialLang(Intl.DateTimeFormat().resolvedOptions().locale)

/** One read of app-settings.json. No file is the app's defaults (no generator, tracking off, the OS
 *  locale); a file that cannot be read or is not a settings object **throws**: tracking cannot be known,
 *  and the caller records nothing rather than guess (E1 error handling). The language follows checks.ts'
 *  lang(): the file's `lang` when it is one, the OS locale otherwise. */
export async function readUnderstandingSettings(settingsPath: string): Promise<UnderstandingSettings> {
  const o = await readAppSettingsObject(settingsPath)
  const lang = o?.lang
  return {
    generator: readGeneratorSettings(o?.generator),
    tracking: o?.workUnitTrackingEnabled === true,
    lang: isLang(lang) ? lang : osLang()
  }
}

export interface HostUnderstandingDeps {
  /** <profile>/understanding.json */
  file: string
  profileDir: string
  /** true while every attached app yields `understanding`, or none is attached. */
  writer(): boolean
  /** accounts.json, read per call. */
  accounts(): Account[] | Promise<Account[]>
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
}

export interface HostUnderstanding {
  /** Once, at Host start, writer or not: the store's load, which marks a record left `generating` as
   *  failed/INTERRUPTED (its agent was a child of the Host that died). Never rejects. */
  load(): Promise<void>
  /** A Run finished (E1 §3): recorded when this Host writes and tracking is on. Resolves once the record
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
    if (!this.may()) return
    await super.set(projectPath, value)
    this.wrote(projectPath)
  }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createHostUnderstanding(d: HostUnderstandingDeps): HostUnderstanding {
  const settingsPath = path.join(d.profileDir, 'app-settings.json')
  const readSettings = d.settings ?? (() => readUnderstandingSettings(settingsPath))

  const isWriter = (): boolean => {
    try {
      return d.writer()
    } catch (err) {
      d.log(`understanding: could not tell whether this Host writes How It Works records, so it does not: ${message(err)}`)
      return false
    }
  }

  /** Set whenever the gate finds an app keeping the duty: that app may write the file meanwhile, so the
   *  next write this Host makes reads the file again first rather than writing back what it held. */
  let stale = false
  let reloading: Promise<void> = Promise.resolve()

  const store = new GatedStore(
    d.file,
    () => {
      if (isWriter()) return true
      stale = true
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

  const loadStore = async (): Promise<void> => {
    try {
      const { recovered } = await store.load()
      if (recovered) d.log('understanding.json could not be read or parsed, kept the .bak and started empty')
    } catch (err) {
      d.log(`understanding.json load failed: ${message(err)}`)
    }
  }
  /** The file again, once, after a spell in which an app was the writer. */
  const fresh = (): Promise<void> => {
    if (stale) {
      stale = false
      reloading = loadStore()
    }
    return reloading
  }

  /** What the pipeline asks synchronously, as the last call read it. */
  let current: { generator: GeneratorSettings; lang: Lang; accounts: Account[] } = { generator: {}, lang: osLang(), accounts: [] }
  /** Settings and accounts, read now; throws when either cannot be read. */
  const take = async (): Promise<UnderstandingSettings> => {
    const s = await readSettings()
    const accounts = await d.accounts()
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
  /** The entry gate: not the writer marks the file stale; the writer reads it again if it was. */
  const enter = async (): Promise<boolean> => {
    if (!isWriter()) {
      stale = true
      return false
    }
    await fresh()
    return true
  }

  return {
    load: loadStore,
    isWriter,
    onRunFinished: async (input) => {
      try {
        if (!(await enter())) return
        let s: UnderstandingSettings
        try {
          s = await take()
        } catch (err) {
          d.log(`understanding: app-settings.json or accounts.json could not be read, run ${input.runId} is not recorded: ${message(err)}`)
          return
        }
        if (!s.tracking) return
        const { projectPath, ...record } = input
        void pipeline.onRunFinished(fold(projectPath), record)
      } catch (err) {
        d.log(`understanding: recording run ${input.runId} failed: ${message(err)}`)
      }
    },
    onUnitClosed: async (projectPath, unit) => {
      if (!(await enter())) return { ok: false, reason: NOT_WRITER }
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
      if (!(await enter())) return { ok: false, status: 409, error: NOT_WRITER }
      const root = fold(projectPath)
      if (!store.get(root)?.records.some((r) => r.id === recordId))
        return { ok: false, status: 404, error: `no How It Works record ${recordId} in ${root}` }
      try {
        await take()
      } catch (err) {
        d.log(`understanding: app-settings.json or accounts.json could not be read, record ${recordId} is not regenerated: ${message(err)}`)
        return { ok: false, status: 500, error: `the settings could not be read: ${message(err)}` }
      }
      void pipeline.regenerate(root, recordId)
      return { ok: true, id: recordId }
    }
  }
}

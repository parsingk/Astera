// The app's side of How It Works since the Host writes it (E1 §2, §4). In front of a Host that announces
// `understanding`, the Host is the one writer: this app reads understanding.json read-only, hands its
// closed session units to the Host as `understanding-unit` and its [다시] presses as
// `understanding-regenerate`, records no Run (the Host records it at its own commit), and forwards the
// Host's `understanding-state` push to the renderer. Before any greeting, and in front of an older Host,
// it keeps its own store and pipeline, as it always has.
//
// The mode is sticky per greeting, as appJournal's writer decision is (P8): a dropped socket does not
// make this app a second writer in front of a Host that is still running and writing. It changes only
// when a Host greets:
// - writer to reader: the generation this app already queued runs to the end and writes its record
//   first (its writes start from the file, so the Host's writes meanwhile survive), bounded by
//   DRAIN_BOUND_MS. Runs are not recorded here from the greeting on, even while that drains: the Host
//   reads this app's yield in the same hello and records them itself.
// - reader to writer (an older Host greets): the store reloads from the file before the next read or
//   write, since the Host wrote it while this app only read.
import { isSamePath } from '../../core/files/tree'
import type { ProjectUnderstanding } from '../../core/understanding/types'
import type { SessionWorkUnit } from '../../core/workUnit/types'
import type { UnderstandingStore } from '../../core/understanding/store'
import type { UnderstandingPipeline, RunRecordInput } from '../../core/understanding/pipeline'
import type { StoreShape } from '../../core/understanding/read'

/** How long a switch to reader waits for this app's own queued generations. */
export const DRAIN_BOUND_MS = 120_000

export interface AppUnderstandingDeps {
  localStore: UnderstandingStore
  localPipeline: UnderstandingPipeline
  /** The last greeting's answer: whether that Host announces `understanding`; null before any greeting. */
  hostAnnounces(): boolean | null
  orchCall(cmd: 'understanding-unit' | 'understanding-regenerate', args: Record<string, unknown>): Promise<{ status: number; body: unknown }>
  /** understanding.json as it is on disk, read-only (core readUnderstandingFile). */
  readFile(): Promise<StoreShape>
  /** The renderer's `understanding:changed`. */
  notify(root: string): void
  log(m: string): void
  /** Test seam: DRAIN_BOUND_MS when left out. */
  drainBoundMs?: number
  /** Test seam: the platform the file's keys are matched on (isSamePath). */
  platform?: string
}

export interface AppUnderstanding {
  /** One project's understanding, by its folded key; null when it has none. */
  get(projectPath: string): Promise<ProjectUnderstanding | null>
  /** A Run finished, with its folded key: recorded here only while no greeted Host announces the duty. */
  onRunFinished(input: RunRecordInput & { projectPath: string }): Promise<void>
  /** A closed session unit, by its folded key. Never rejects. */
  onUnitClosed(projectPath: string, unit: SessionWorkUnit): Promise<void>
  /** [다시]. Local: starts it and returns. Reader: rejects when the Host does not take it. */
  regenerate(projectPath: string, recordId: string): Promise<void>
  /** A Host just greeted; resolves once the mode follows it. Never rejects. */
  onGreeting(announces: boolean): Promise<void>
  /** The Host's `understanding-state`. */
  onHostPush(root: string): void
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createAppUnderstanding(d: AppUnderstandingDeps): AppUnderstanding {
  let mode: 'writer' | 'reader' = 'writer'
  /** Bumped by every greeting: a switch still draining gives way to a later greeting's answer. */
  let greetings = 0
  /** The last promise the local pipeline handed back. Its queue is serial, so this settles after
   *  everything queued before it. */
  let localTail: Promise<void> = Promise.resolve()
  const local = (p: Promise<void>): Promise<void> => (localTail = p)
  /** The reload after a switch back to writer; every local read and write waits for it. */
  let reloaded: Promise<void> = Promise.resolve()

  /** Waits for the local queue, including what is queued while it waits; false when the bound ran out. */
  const drain = async (): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const out = new Promise<'out'>((r) => (timer = setTimeout(() => r('out'), d.drainBoundMs ?? DRAIN_BOUND_MS)))
    try {
      for (;;) {
        const seen = localTail
        if ((await Promise.race([seen.then(() => 'done' as const), out])) === 'out') return false
        if (seen === localTail) return true
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** The file's own spelling of this project's key (isSamePath), or undefined when it has none. */
  const keyIn = (state: StoreShape, projectPath: string): string | undefined =>
    Object.keys(state.projects).find((k) => isSamePath(k, projectPath, d.platform))

  return {
    get: async (projectPath) => {
      if (mode === 'writer') {
        await reloaded
        return d.localStore.get(projectPath) ?? null
      }
      let state: StoreShape
      try {
        state = await d.readFile()
      } catch (err) {
        d.log(`understanding: could not read the Host's How It Works file: ${message(err)}`)
        throw err
      }
      // The Host folds the key over its own registry: matched as a path, not as a string.
      const key = keyIn(state, projectPath)
      return key === undefined ? null : state.projects[key]
    },
    onRunFinished: async ({ projectPath, ...input }) => {
      // The greeting's answer, not the mode: the Host records Runs from the hello on, drain or not.
      if (d.hostAnnounces() === true) return
      await reloaded
      await local(d.localPipeline.onRunFinished(projectPath, input))
    },
    onUnitClosed: async (projectPath, unit) => {
      if (mode === 'writer') {
        await reloaded
        await local(d.localPipeline.onUnitClosed(projectPath, unit))
        return
      }
      // A 409 or a lost link drops the unit: never written here while a writer Host exists (E1 §4).
      await Promise.resolve()
        .then(() => d.orchCall('understanding-unit', { projectPath, unit }))
        .then(
          (r) => {
            if (r.status !== 200) d.log(`understanding: the Host did not take a closed unit (${r.status}): ${JSON.stringify(r.body)}`)
          },
          (err) => d.log(`understanding: a closed unit could not reach the Host and is dropped: ${message(err)}`)
        )
    },
    regenerate: async (projectPath, recordId) => {
      if (mode === 'writer') {
        await reloaded
        void local(d.localPipeline.regenerate(projectPath, recordId))
        return
      }
      // As the file spells it: the Host looks the record up by that exact key, and get matched it as a path.
      const key = await d.readFile().then(
        (state) => keyIn(state, projectPath),
        () => undefined
      )
      const r = await d.orchCall('understanding-regenerate', { projectPath: key ?? projectPath, recordId })
      if (r.status !== 200) {
        const error = (r.body as { error?: unknown } | null)?.error
        throw new Error(typeof error === 'string' ? error : `the Host answered ${r.status}`)
      }
    },
    onGreeting: async (announces) => {
      const seq = ++greetings
      if (announces) {
        if (mode === 'reader') return
        const drained = await drain()
        if (seq !== greetings) return
        if (!drained)
          d.log(`understanding: this app's own write-up did not finish within ${(d.drainBoundMs ?? DRAIN_BOUND_MS) / 1000} s; the Host writes How It Works from now on`)
        mode = 'reader'
        return
      }
      if (mode === 'writer') return
      mode = 'writer'
      reloaded = d.localStore.refresh().then(
        () => {},
        (err) => d.log(`understanding: reloading How It Works from the file failed: ${message(err)}`)
      )
      await reloaded
    },
    onHostPush: (root) => {
      try {
        d.notify(root)
      } catch (err) {
        d.log(`understanding: the Host's push could not reach the window: ${message(err)}`)
      }
    }
  }
}

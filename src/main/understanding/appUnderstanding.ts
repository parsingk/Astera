// The app's side of How It Works since the Host writes it (E1 §2, §4). In front of a Host that announces
// `understanding`, the Host is the one writer: this app reads understanding.json read-only, hands its
// closed session units to the Host as `understanding-unit` and its [다시] presses as
// `understanding-regenerate`, records no Run (the Host records it at its own commit), and forwards the
// Host's `understanding-state` push to the renderer. Before any greeting, and in front of an older Host,
// it keeps its own store and pipeline, as it always has.
//
// The mode is sticky per greeting, as appJournal's writer decision is (P8). **A reader whose Host is gone
// stays a reader** until the next greeting: a dropped socket does not make this app a second writer in
// front of a Host that may still be running and writing, so a closed unit is dropped (logged) and a
// regenerate is refused until a Host answers again. The app restarts a Host when none answers, and that
// Host's greeting decides.
//
// The switches, both at the greeting itself:
// - writer to reader is **immediate and single-writer** (E1 §2, review ruling 6). The Host is the writer
//   from the hello on, so the app's store stops writing in the same turn (AppUnderstandingStore's gate),
//   and nothing the app's pipeline still does reaches the file. What it was doing is handed to the Host:
//   every record this app put in `generating` goes as `understanding-regenerate` (its agent run is wasted),
//   and every unit or regenerate it had not started yet goes as the call it would have been. A Run waiting
//   in that queue cannot be handed over (no call takes one) and is logged.
// - reader to writer (an older Host greets): the gate opens and the store reloads from the file, which
//   the Host wrote while this app only read.
import { isSamePath } from '../../core/files/tree'
import type { ProjectUnderstanding } from '../../core/understanding/types'
import type { SessionWorkUnit } from '../../core/workUnit/types'
import { UnderstandingStore } from '../../core/understanding/store'
import type { UnderstandingPipeline, RunRecordInput } from '../../core/understanding/pipeline'
import type { StoreShape } from '../../core/understanding/read'

/** The app's store: the core store with a write gate, and a memory of which `generating` records this
 *  process made, so the switch hands over its own write-ups and not ones it only read from the file. */
export class AppUnderstandingStore extends UnderstandingStore {
  private gated = false
  /** Record id to project key, for each record this process set to `generating`. */
  private readonly mine = new Map<string, string>()
  /** Counts the records this process set to `generating`: tells whether a pipeline step started its record. */
  started = 0

  /** Closed: set and remove do nothing, memory included, as the Host's GatedStore drops a write. */
  gate(closed: boolean): void {
    this.gated = closed
  }

  override set(projectPath: string, value: ProjectUnderstanding): Promise<void> {
    if (this.gated) return Promise.resolve()
    const before = new Map((this.get(projectPath)?.records ?? []).map((r) => [r.id, r.status]))
    for (const r of value.records) {
      if (r.status !== 'generating') this.mine.delete(r.id)
      else if (before.get(r.id) !== 'generating') {
        this.mine.set(r.id, projectPath)
        this.started += 1
      }
    }
    return super.set(projectPath, value)
  }

  override remove(projectPath: string): Promise<void> {
    if (this.gated) return Promise.resolve()
    return super.remove(projectPath)
  }

  /** The records this process set to `generating` that still are, in memory. */
  ownGenerating(): Array<{ projectPath: string; recordId: string }> {
    const out: Array<{ projectPath: string; recordId: string }> = []
    for (const [recordId, projectPath] of this.mine)
      if (this.get(projectPath)?.records.some((r) => r.id === recordId && r.status === 'generating')) out.push({ projectPath, recordId })
    return out
  }
}

export interface AppUnderstandingDeps {
  localStore: AppUnderstandingStore
  localPipeline: UnderstandingPipeline
  /** The last greeting's answer: whether that Host announces `understanding`; null before any greeting. */
  hostAnnounces(): boolean | null
  orchCall(cmd: 'understanding-unit' | 'understanding-regenerate', args: Record<string, unknown>): Promise<{ status: number; body: unknown }>
  /** understanding.json as it is on disk, read-only (core readUnderstandingFile). */
  readFile(): Promise<StoreShape>
  /** The renderer's `understanding:changed`. */
  notify(root: string): void
  log(m: string): void
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

/** One piece of local work, waiting for the pipeline or in it. */
type Step =
  | { kind: 'unit'; projectPath: string; unit: SessionWorkUnit }
  | { kind: 'regenerate'; projectPath: string; recordId: string }
  | { kind: 'run'; input: RunRecordInput & { projectPath: string } }

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function createAppUnderstanding(d: AppUnderstandingDeps): AppUnderstanding {
  let mode: 'writer' | 'reader' = 'writer'
  /** The reload after a switch back to writer. It matters for a writer-mode `get`, which reads memory:
   *  the pipeline refreshes from the file before each of its writes anyway. */
  let reloaded: Promise<void> = Promise.resolve()
  /** Local work not handed to the pipeline yet, in order. Fed one step at a time, so a switch knows
   *  which steps the pipeline never saw. */
  const waiting: Array<{ step: Step; done: () => void }> = []
  /** The step in the pipeline now, and `started` as it was when it went in. */
  let inPipeline: { step: Step; started: number } | null = null
  let pumping = false

  const runStep = (step: Step): Promise<void> => {
    if (step.kind === 'unit') return d.localPipeline.onUnitClosed(step.projectPath, step.unit)
    if (step.kind === 'regenerate') return d.localPipeline.regenerate(step.projectPath, step.recordId)
    const { projectPath, ...input } = step.input
    return d.localPipeline.onRunFinished(projectPath, input)
  }
  const pump = async (): Promise<void> => {
    if (pumping) return
    pumping = true
    try {
      await reloaded
      while (mode === 'writer' && waiting.length > 0) {
        const next = waiting.shift()!
        inPipeline = { step: next.step, started: d.localStore.started }
        try {
          await runStep(next.step) // never rejects (the pipeline's enqueue)
        } finally {
          inPipeline = null
          next.done()
        }
      }
    } finally {
      pumping = false
    }
  }
  const local = (step: Step): Promise<void> =>
    new Promise<void>((done) => {
      waiting.push({ step, done })
      void pump()
    })

  /** The file's own spelling of this project's key (isSamePath), or undefined when it has none. */
  const keyIn = (state: StoreShape, projectPath: string): string | undefined =>
    Object.keys(state.projects).find((k) => isSamePath(k, projectPath, d.platform))

  const sendUnit = (projectPath: string, unit: SessionWorkUnit): Promise<void> =>
    // A 409 or a lost link drops the unit: never written here while a writer Host exists (E1 §4).
    Promise.resolve()
      .then(() => d.orchCall('understanding-unit', { projectPath, unit }))
      .then(
        (r) => {
          if (r.status !== 200) d.log(`understanding: the Host did not take a closed unit (${r.status}): ${JSON.stringify(r.body)}`)
        },
        (err) => d.log(`understanding: a closed unit could not reach the Host and is dropped: ${message(err)}`)
      )
  /** A write-up this app started, handed to the Host at the switch: logged when the Host does not take it. */
  const handOver = (projectPath: string, recordId: string): Promise<void> =>
    Promise.resolve()
      .then(() => d.orchCall('understanding-regenerate', { projectPath, recordId }))
      .then(
        (r) => {
          if (r.status !== 200) d.log(`understanding: the Host did not take over the write-up of ${recordId} (${r.status}): ${JSON.stringify(r.body)}`)
        },
        (err) => d.log(`understanding: the write-up of ${recordId} could not be handed to the Host: ${message(err)}`)
      )
  const handStep = (step: Step): Promise<void> => {
    if (step.kind === 'unit') return sendUnit(step.projectPath, step.unit)
    if (step.kind === 'regenerate') return handOver(step.projectPath, step.recordId)
    d.log(`understanding: Run ${step.input.runId} finished before the Host took How It Works over, and is not recorded`)
    return Promise.resolve()
  }

  /** Writer to reader, in the greeting's own turn. */
  const yieldToHost = async (): Promise<void> => {
    d.localStore.gate(true)
    mode = 'reader'
    const own = d.localStore.ownGenerating()
    // The pipeline took this step but has not started its record: the Host is handed the step instead.
    const held = inPipeline && d.localStore.started === inPipeline.started ? inPipeline.step : null
    const queued = waiting.splice(0)
    // The saves queued before the gate closed land first: the Host looks a handed-over record up in the
    // file, and would answer 404 for one still only in this app's memory.
    await d.localStore.settled()
    const sends: Array<Promise<void>> = own.map((g) => handOver(g.projectPath, g.recordId))
    if (held) sends.push(handStep(held))
    for (const w of queued) sends.push(handStep(w.step).then(w.done))
    await Promise.all(sends)
  }

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
    onRunFinished: async (input) => {
      // The greeting's answer: the Host records Runs from the hello on.
      if (d.hostAnnounces() === true || mode === 'reader') return
      await local({ kind: 'run', input })
    },
    onUnitClosed: async (projectPath, unit) => {
      if (mode === 'writer') return local({ kind: 'unit', projectPath, unit })
      await sendUnit(projectPath, unit)
    },
    regenerate: async (projectPath, recordId) => {
      if (mode === 'writer') {
        void local({ kind: 'regenerate', projectPath, recordId })
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
      if (announces) {
        if (mode === 'writer') await yieldToHost()
        return
      }
      if (mode === 'writer') return
      d.localStore.gate(false)
      mode = 'writer'
      reloaded = d.localStore.refresh().then(
        () => {},
        (err) => d.log(`understanding: reloading How It Works from the file failed: ${message(err)}`)
      )
      await reloaded
      void pump()
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

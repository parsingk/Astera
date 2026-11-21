import { useEffect, useRef, useState } from 'react'
import type { Dependents, LiveOp, LivePreview, Read } from '../../../core/kube/cluster/types'
import { liveRef, replicasOf } from '../../../core/kube/cluster/write'
import type { KubeRunResult } from '../../../core/kube/types'
import { writeConfirmable } from '../components/kube/KubeWriteDialog'
import { writeThrough } from '../lib/writeThrough'
import { errText } from './useFileOps'
import type { KubeLogEntry } from './useKubeOps'

/** How long the scale field must rest before its count is previewed. */
const SCALE_WAIT_MS = 400

/** The confirmation of one live write (cluster view). `phase` is `previewing` while the answer to ask `seq` is awaited
 *  (the earlier diff stays shown, stale), `confirming` once it is shown, `running` from confirm until the run `runId`
 *  answers. `opened` names the dialog, so the dependents of an earlier one never land in a later one. */
export interface LiveDialog {
  op: LiveOp
  preview: LivePreview | null
  /** Delete only; null while loading. */
  dependents: Read<{ dependents: Dependents }> | null
  keepServerFields: boolean
  showValues: boolean
  /** Scale only: the field's text, which may be ahead of `op.replicas` (the count the shown preview is for). */
  replicas: string
  typed: string
  stale: boolean
  phase: 'previewing' | 'confirming' | 'running'
  seq: number
  opened: number
  runId: string | null
  cancelling: boolean
}

export interface LiveWriteState {
  dialog: LiveDialog | null
  seq: number
}

export const initialLiveWrites: LiveWriteState = { dialog: null, seq: 0 }

export type LiveWriteAction =
  | { type: 'open'; op: LiveOp; replicas: string }
  | { type: 'previewed'; seq: number; preview: LivePreview }
  | { type: 'dependents'; opened: number; result: Read<{ dependents: Dependents }> }
  | { type: 'replicas'; text: string }
  /** The wait after the last change of the field is over: preview `text`, if it is still the field's text. */
  | { type: 'scaleAsk'; text: string }
  | { type: 'toggleServerFields' }
  | { type: 'toggleValues' }
  | { type: 'typed'; text: string }
  | { type: 'confirm'; id: string }
  | { type: 'cancel' }
  | { type: 'ran'; result: KubeRunResult }
  | { type: 'close' }

/** Whether what the dialog shows is what the field says: a scale needs a valid count that its op already carries. */
const settled = (d: LiveDialog): boolean => d.op.verb !== 'scale' || (replicasOf(d.replicas) === d.op.replicas)

/** Whether a preview can be asked now (a scale waits for its field to settle). */
export const askable = (d: LiveDialog): boolean => d.phase === 'previewing' && settled(d)

const asking = (s: LiveWriteState, d: LiveDialog, fields: Partial<LiveDialog>): LiveWriteState => ({
  ...s,
  seq: s.seq + 1,
  dialog: { ...d, ...fields, phase: 'previewing', seq: s.seq + 1 }
})

/** The dialog as pure state; the hook does the IPC each transition asks for. */
export function liveWriteReducer(s: LiveWriteState, a: LiveWriteAction): LiveWriteState {
  const d = s.dialog
  switch (a.type) {
    case 'open': {
      // A run in progress is never replaced from under its own answer.
      if (d?.phase === 'running') return s
      const n = a.op.verb === 'scale' ? replicasOf(a.replicas) : null
      const op = a.op.verb === 'scale' && n !== null ? { ...a.op, replicas: n } : a.op
      const dialog: LiveDialog = {
        op,
        preview: null,
        dependents: null,
        keepServerFields: false,
        showValues: false,
        replicas: a.replicas,
        typed: '',
        stale: false,
        phase: 'previewing',
        seq: s.seq + 1,
        opened: s.seq + 1,
        runId: null,
        cancelling: false
      }
      return { seq: s.seq + 1, dialog: { ...dialog, stale: !settled(dialog) } }
    }
    case 'previewed': {
      if (!d || d.phase !== 'previewing' || d.seq !== a.seq) return s
      return { ...s, dialog: { ...d, preview: a.preview, stale: !settled(d), phase: 'confirming' } }
    }
    case 'dependents':
      return d && d.opened === a.opened ? { ...s, dialog: { ...d, dependents: a.result } } : s
    // A new text makes every answer in flight an old one, and the dialog unconfirmable until its own preview is shown.
    case 'replicas':
      return d && d.op.verb === 'scale' && d.phase !== 'running' ? asking(s, d, { replicas: a.text, stale: true, ...(replicasOf(a.text) === null ? { preview: null } : {}) }) : s
    case 'scaleAsk': {
      const n = replicasOf(a.text)
      if (!d || d.op.verb !== 'scale' || d.phase !== 'previewing' || d.replicas !== a.text || n === null) return s
      return asking(s, { ...d, op: { ...d.op, replicas: n } }, { stale: true })
    }
    case 'toggleServerFields':
      return d && d.phase !== 'running' ? asking(s, d, { keepServerFields: !d.keepServerFields, preview: null, stale: !settled(d) }) : s
    case 'toggleValues':
      return d && d.phase !== 'running' ? asking(s, d, { showValues: !d.showValues, preview: null, stale: !settled(d) }) : s
    case 'typed':
      return d && d.phase !== 'running' ? { ...s, dialog: { ...d, typed: a.text } } : s
    case 'confirm': {
      if (!d || d.phase !== 'confirming') return s
      if (!writeConfirmable({ op: d.op, preview: d.preview, dependents: d.dependents, typed: d.typed, stale: d.stale, running: false })) return s
      return { ...s, dialog: { ...d, phase: 'running', runId: a.id, cancelling: false } }
    }
    case 'cancel':
      return d && d.phase === 'running' ? { ...s, dialog: { ...d, cancelling: true } } : s
    case 'ran': {
      if (!d || d.phase !== 'running' || d.runId !== a.result.id) return s
      // Nothing was written: the same dialog previews again, the op (and an edit's text) kept, so the person confirms what
      // the object is now.
      // A delete's dependents are read again: the object may be another one made under the same name (owners go by uid),
      // and `opened` moves so a late answer for the old ask is dropped.
      if (a.result.refused?.reason === 'changed') {
        const dependents = d.op.verb === 'delete' ? null : d.dependents
        return asking(s, { ...d, runId: null, cancelling: false }, { stale: true, dependents, opened: s.seq + 1 })
      }
      return { ...s, dialog: null }
    }
    case 'close':
      return d && d.phase !== 'running' ? { ...s, dialog: null } : s
  }
}

/** A run's answer: the dialog closes (or previews again after a refusal), and a written object is reported. */
export function finishRun(s: LiveWriteState, result: KubeRunResult, onWritten?: () => void): LiveWriteState {
  const next = liveWriteReducer(s, { type: 'ran', result })
  if (result.ok && s.dialog?.phase === 'running' && s.dialog.runId === result.id) onWritten?.()
  return next
}

const failedPreview = (err: unknown): LivePreview => ({
  ok: false,
  reason: 'kubectl',
  commandLines: [],
  checkCommandLines: [],
  stderr: errText(err)
})

/** The op a log entry reopens: the command line never holds an edit's text, so an edit has none. */
const rerunOf = (op: LiveOp): Exclude<LiveOp, { verb: 'replace' }> | null => (op.verb === 'replace' ? null : op)

export interface LiveWriteApi {
  write: Pick<typeof window.api.kube.write, 'preview' | 'run' | 'cancel'>
  cluster: Pick<typeof window.api.kube.cluster, 'dependents'>
}

/** What the driver needs of its host: the state it drives (`commit` takes the next state of the current one, once), the
 *  IPC, and the operation log. */
export interface LiveWriteEnv {
  state(): LiveWriteState
  commit(next: (cur: LiveWriteState) => LiveWriteState): void
  api(): LiveWriteApi
  log(): { logLive(e: KubeLogEntry): void; finishLive(r: KubeRunResult): void }
}

/** The IPC and timing behind the reducer, without React: previews, dependents, the scale wait, runs and the log. */
export function createLiveWrites(env: LiveWriteEnv) {
  let onWritten: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | null = null
  const dispatch = (a: LiveWriteAction): void => env.commit((cur) => liveWriteReducer(cur, a))
  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  /** Asks for the preview the dialog now waits for. */
  const ask = (): void => {
    const d = env.state().dialog
    if (!d || !askable(d)) return
    const { seq } = d
    env
      .api()
      .write.preview(d.op, { keepServerFields: d.keepServerFields, showValues: d.showValues })
      .catch(failedPreview)
      .then((preview) => dispatch({ type: 'previewed', seq, preview }))
  }

  /** A delete's dependents, while the dialog has none: when it opens and again after a refused run. */
  const askDependents = (): void => {
    const d = env.state().dialog
    if (!d || d.op.verb !== 'delete' || d.dependents !== null) return
    const { opened } = d
    env
      .api()
      .cluster.dependents(d.op.ref)
      .catch((err: unknown): Read<{ dependents: Dependents }> => ({ ok: false, message: errText(err) }))
      .then((result) => dispatch({ type: 'dependents', opened, result }))
  }

  const start = (op: LiveOp, written?: () => void, replicas?: string): void => {
    if (env.state().dialog?.phase === 'running') return
    clearTimer()
    onWritten = written
    dispatch({ type: 'open', op, replicas: replicas ?? (op.verb === 'scale' ? String(op.replicas) : '') })
    askDependents()
    ask()
  }

  const setReplicas = (text: string): void => {
    dispatch({ type: 'replicas', text })
    clearTimer()
    if (replicasOf(text) === null) return
    timer = setTimeout(() => {
      timer = null
      dispatch({ type: 'scaleAsk', text })
      ask()
    }, SCALE_WAIT_MS)
  }

  const confirm = (): void => {
    const id = crypto.randomUUID()
    dispatch({ type: 'confirm', id })
    const d = env.state().dialog
    if (!d || d.runId !== id || !d.preview?.ok) return
    const { op } = d
    const target = liveRef(op.ref)
    const startedAt = Date.now()
    env.log().logLive({
      id,
      verb: op.verb,
      context: op.ref.context,
      scope: target,
      commandLines: d.preview.commandLines,
      startedAt,
      state: 'running',
      namespaceLabel: op.ref.namespace ?? '',
      live: { ref: op.ref, rerun: rerunOf(op) }
    })
    env
      .api()
      .write.run(id, op, d.preview.fingerprint)
      .catch(
        (err: unknown): KubeRunResult => ({
          id,
          verb: op.verb,
          target,
          context: op.ref.context,
          commandLines: [],
          ran: 0,
          outcomes: [],
          ok: false,
          stderr: errText(err),
          startedAt,
          finishedAt: Date.now()
        })
      )
      .then((result) => {
        env.log().finishLive(result)
        env.commit((cur) => finishRun(cur, result, onWritten))
        // A run refused as changed previews the same op again, and a delete reads its dependents again.
        ask()
        askDependents()
      })
  }

  /** The dialog's stop button. */
  const abort = (): void => {
    const runId = env.state().dialog?.runId
    if (!runId) return
    dispatch({ type: 'cancel' })
    void env.api().write.cancel(runId).catch(() => {})
  }

  return {
    start,
    confirm,
    abort,
    /** The log's stop button: the dialog's own stop while it is that run's, else the run alone (its dialog is gone). */
    cancelRun: (id: string): void => {
      if (env.state().dialog?.runId === id) abort()
      else void env.api().write.cancel(id).catch(() => {})
    },
    close: (): void => {
      clearTimer()
      dispatch({ type: 'close' })
    },
    toggleServerFields: (): void => {
      dispatch({ type: 'toggleServerFields' })
      ask()
    },
    toggleValues: (): void => {
      dispatch({ type: 'toggleValues' })
      ask()
    },
    setReplicas,
    setTyped: (text: string): void => dispatch({ type: 'typed', text }),
    /** The host went away: no preview is asked after the scale wait. */
    dispose: clearTimer
  }
}

/** Writes to objects already in the cluster, from the cluster view (board D): previews each in a confirmation, runs it on
 *  confirm, and keeps its entry in the operation log. */
export function useLiveWrites(log: { logLive(e: KubeLogEntry): void; finishLive(r: KubeRunResult): void }) {
  const stateRef = useRef(initialLiveWrites)
  const [state, setState] = useState(initialLiveWrites)
  const logRef = useRef(log)
  logRef.current = log
  const driver = useRef<ReturnType<typeof createLiveWrites> | null>(null)
  if (driver.current === null) {
    const commit = writeThrough(stateRef, setState)
    driver.current = createLiveWrites({
      state: () => stateRef.current,
      commit,
      api: () => window.api.kube,
      log: () => logRef.current
    })
  }
  const d = driver.current
  useEffect(() => () => d.dispose(), [d])
  return { dialog: state.dialog, ...d }
}

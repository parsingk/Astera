import { useEffect, useRef, useState } from 'react'
import type { Dependents, LiveOp, LivePreview, Read } from '../../../core/kube/cluster/types'
import { liveRef } from '../../../core/kube/cluster/write'
import type { KubeRunResult } from '../../../core/kube/types'
import { writeConfirmable } from '../components/kube/KubeWriteDialog'
import { writeThrough } from '../lib/writeThrough'
import { errText } from './useFileOps'
import type { KubeLogEntry } from './useKubeOps'

/** How long the scale field must rest before its count is previewed. */
const SCALE_WAIT_MS = 400
const MAX_REPLICAS = 2147483647

/** The scale field's text as a count the API takes (an integer 0..2147483647), else null. */
export function replicasOf(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null
  const n = Number(text)
  return n <= MAX_REPLICAS ? n : null
}

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
      return d && d.op.verb === 'scale' && d.phase !== 'running' ? asking(s, d, { replicas: a.text, stale: true }) : s
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
      if (a.result.refused?.reason === 'changed') return asking(s, { ...d, runId: null, cancelling: false }, { stale: true })
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

/** Writes to objects already in the cluster, from the cluster view (board D): previews each in a confirmation, runs it on
 *  confirm, and keeps its entry in the operation log. */
export function useLiveWrites(log: { logLive(e: KubeLogEntry): void; finishLive(r: KubeRunResult): void }) {
  const stateRef = useRef(initialLiveWrites)
  const [state, setState] = useState(initialLiveWrites)
  const commit = writeThrough(stateRef, setState)
  const dispatch = (a: LiveWriteAction): void => commit((cur) => liveWriteReducer(cur, a))
  const logRef = useRef(log)
  logRef.current = log
  const onWrittenRef = useRef<(() => void) | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearTimer = (): void => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => clearTimer, [])

  /** Asks for the preview the dialog now waits for. */
  const ask = (): void => {
    const d = stateRef.current.dialog
    if (!d || !askable(d)) return
    const { seq } = d
    window.api.kube.write
      .preview(d.op, { keepServerFields: d.keepServerFields, showValues: d.showValues })
      .catch(failedPreview)
      .then((preview) => dispatch({ type: 'previewed', seq, preview }))
  }

  const start = (op: LiveOp, onWritten?: () => void, replicas?: string): void => {
    clearTimer()
    onWrittenRef.current = onWritten
    dispatch({ type: 'open', op, replicas: replicas ?? (op.verb === 'scale' ? String(op.replicas) : '') })
    const opened = stateRef.current.dialog?.opened ?? 0
    if (op.verb === 'delete') {
      window.api.kube.cluster
        .dependents(op.ref)
        .catch((err: unknown): Read<{ dependents: Dependents }> => ({ ok: false, message: errText(err) }))
        .then((result) => dispatch({ type: 'dependents', opened, result }))
    }
    ask()
  }

  const setReplicas = (text: string): void => {
    dispatch({ type: 'replicas', text })
    clearTimer()
    if (replicasOf(text) === null) return
    timer.current = setTimeout(() => {
      timer.current = null
      dispatch({ type: 'scaleAsk', text })
      ask()
    }, SCALE_WAIT_MS)
  }

  const confirm = (): void => {
    const before = stateRef.current.dialog
    if (!before) return
    const id = crypto.randomUUID()
    dispatch({ type: 'confirm', id })
    const d = stateRef.current.dialog
    if (!d || d.runId !== id || !d.preview?.ok) return
    const { op } = d
    const target = liveRef(op.ref)
    const startedAt = Date.now()
    logRef.current.logLive({
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
    window.api.kube.write
      .run(id, op, d.preview.fingerprint)
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
        logRef.current.finishLive(result)
        commit((cur) => finishRun(cur, result, onWrittenRef.current))
        // A run refused as changed previews the same op again.
        ask()
      })
  }

  const abort = (): void => {
    const runId = stateRef.current.dialog?.runId
    if (!runId) return
    dispatch({ type: 'cancel' })
    void window.api.kube.write.cancel(runId).catch(() => {})
  }

  return {
    dialog: state.dialog,
    start,
    confirm,
    abort,
    close: () => {
      clearTimer()
      dispatch({ type: 'close' })
    },
    toggleServerFields: () => {
      dispatch({ type: 'toggleServerFields' })
      ask()
    },
    toggleValues: () => {
      dispatch({ type: 'toggleValues' })
      ask()
    },
    setReplicas,
    setTyped: (text: string) => dispatch({ type: 'typed', text })
  }
}

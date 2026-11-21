import { describe, it, expect, vi } from 'vitest'
import type { Dependents, LiveOp, LivePreview, ObjectRef } from '../../../core/kube/cluster/types'
import type { KubeRunResult } from '../../../core/kube/types'
import { writeConfirmable } from '../components/kube/KubeWriteDialog'
import { finishRun, initialLiveWrites, liveWriteReducer, type LiveWriteAction, type LiveWriteState } from './useLiveWrites'

const ref = (kind: string, name: string, namespace: string | null = 'dev'): ObjectRef => ({
  context: 'kind-dev',
  namespace,
  resource: kind.toLowerCase() + 's',
  kind,
  name
})
const okPreview = (fingerprint = 'fp1'): LivePreview =>
  ({ ok: true, commandLines: [['delete', 'x']], checkCommandLines: [], diff: { ref: 'x', rows: [] }, fingerprint }) as unknown as LivePreview
const deps: Dependents = { goes: [], kept: [], affected: [], incomplete: false, recreatedBy: null }
const result = (over: Partial<KubeRunResult> = {}): KubeRunResult => ({
  id: 'run1',
  verb: 'restart',
  context: 'kind-dev',
  commandLines: [],
  ran: 1,
  outcomes: [],
  ok: true,
  stderr: '',
  startedAt: 1,
  finishedAt: 2,
  ...over
})

const run = (actions: LiveWriteAction[], from: LiveWriteState = initialLiveWrites): LiveWriteState => actions.reduce(liveWriteReducer, from)
const restart: LiveOp = { verb: 'restart', ref: ref('Deployment', 'web') }
const opened = (op: LiveOp = restart, replicas = ''): LiveWriteState => run([{ type: 'open', op, replicas }])
const shown = (s: LiveWriteState, fp = 'fp1'): LiveWriteState => liveWriteReducer(s, { type: 'previewed', seq: s.dialog!.seq, preview: okPreview(fp) })
const confirmable = (s: LiveWriteState): boolean => {
  const d = s.dialog!
  return d.phase === 'confirming' && writeConfirmable({ op: d.op, preview: d.preview, dependents: d.dependents, typed: d.typed, stale: d.stale, running: false })
}

describe('liveWriteReducer', () => {
  it('drops a preview answer for an older ask', () => {
    const first = opened()
    const second = liveWriteReducer(first, { type: 'toggleServerFields' })
    const late = liveWriteReducer(second, { type: 'previewed', seq: first.dialog!.seq, preview: okPreview('old') })
    expect(late.dialog!.preview).toBeNull()
    expect(late.dialog!.phase).toBe('previewing')
    const current = liveWriteReducer(second, { type: 'previewed', seq: second.dialog!.seq, preview: okPreview('new') })
    expect(current.dialog!.preview).toMatchObject({ fingerprint: 'new' })
    expect(current.dialog!.phase).toBe('confirming')
  })

  it("previews again after a refused run, keeping the op and an edit's text", () => {
    const edit: LiveOp = { verb: 'replace', ref: ref('ConfigMap', 'cfg'), text: 'a: 1', base: { resourceVersion: '5', hash: 'h' } }
    const running = run([{ type: 'confirm', id: 'run1' }], shown(opened(edit)))
    expect(running.dialog!.phase).toBe('running')
    const again = liveWriteReducer(running, { type: 'ran', result: result({ verb: 'replace', ok: false, ran: 0, refused: { reason: 'changed' } }) })
    expect(again.dialog).not.toBeNull()
    expect(again.dialog!.op).toEqual(edit)
    expect(again.dialog!.phase).toBe('previewing')
    expect(again.dialog!.stale).toBe(true)
    expect(again.dialog!.runId).toBeNull()
    expect(again.dialog!.seq).toBeGreaterThan(running.dialog!.seq)
  })

  it('closes and calls back after a successful run', () => {
    const running = run([{ type: 'confirm', id: 'run1' }], shown(opened()))
    const written = vi.fn()
    const next = finishRun(running, result(), written)
    expect(next.dialog).toBeNull()
    expect(written).toHaveBeenCalledTimes(1)
    const failed = vi.fn()
    expect(finishRun(running, result({ ok: false }), failed).dialog).toBeNull()
    expect(failed).not.toHaveBeenCalled()
    // An answer for another run changes nothing.
    expect(finishRun(running, result({ id: 'other' }), failed).dialog).toBe(running.dialog)
  })

  it('keeps the dialog stale until the scale preview answers', () => {
    const scale: LiveOp = { verb: 'scale', ref: ref('Deployment', 'web'), replicas: 3 }
    const first = shown(opened(scale, '3'))
    expect(confirmable(first)).toBe(true)
    const typed = liveWriteReducer(first, { type: 'replicas', text: '5' })
    expect(typed.dialog!.stale).toBe(true)
    expect(confirmable(typed)).toBe(false)
    // A late answer for the first ask must not unlock it.
    const late = liveWriteReducer(typed, { type: 'previewed', seq: first.dialog!.seq, preview: okPreview('late') })
    expect(late.dialog!.stale).toBe(true)
    const asked = liveWriteReducer(typed, { type: 'scaleAsk', text: '5' })
    expect(asked.dialog!.op).toEqual({ ...scale, replicas: 5 })
    expect(asked.dialog!.stale).toBe(true)
    expect(confirmable(asked)).toBe(false)
    const answered = shown(asked, 'fp5')
    expect(answered.dialog!.stale).toBe(false)
    expect(confirmable(answered)).toBe(true)
    // A text that is not a count asks nothing and keeps the dialog stale.
    for (const text of ['', '-1', '1.5', '2147483648', 'x']) {
      const bad = liveWriteReducer(answered, { type: 'replicas', text })
      expect(bad.dialog!.stale).toBe(true)
      const after = liveWriteReducer(bad, { type: 'scaleAsk', text })
      expect(after.dialog!.stale).toBe(true)
      expect(after.dialog!.op).toEqual({ ...scale, replicas: 5 })
    }
    // A wait that was overtaken by a newer text asks nothing.
    const superseded = liveWriteReducer(typed, { type: 'replicas', text: '6' })
    expect(liveWriteReducer(superseded, { type: 'scaleAsk', text: '5' }).dialog!.op).toEqual({ ...scale, replicas: 3 })
  })

  it('starts a scale dialog with no preview while the count is unknown', () => {
    const s = opened({ verb: 'scale', ref: ref('Deployment', 'web'), replicas: 0 }, '')
    expect(s.dialog!.stale).toBe(true)
    expect(s.dialog!.replicas).toBe('')
    expect(confirmable(shown(s))).toBe(false)
  })

  it('gates confirm by writeConfirmable', () => {
    const del: LiveOp = { verb: 'delete', ref: ref('Namespace', 'dev', null) }
    const base = shown(opened(del))
    // The dependents have not answered, then the name is not typed.
    expect(liveWriteReducer(base, { type: 'confirm', id: 'r' })).toBe(base)
    const withDeps = liveWriteReducer(base, { type: 'dependents', opened: base.dialog!.opened, result: { ok: true, dependents: deps } })
    expect(liveWriteReducer(withDeps, { type: 'confirm', id: 'r' })).toBe(withDeps)
    const typed = run([{ type: 'typed', text: 'dev' }], withDeps)
    const running = liveWriteReducer(typed, { type: 'confirm', id: 'r' })
    expect(running.dialog!.phase).toBe('running')
    expect(running.dialog!.runId).toBe('r')
    // A stale dialog cannot be confirmed either.
    const stale = liveWriteReducer(typed, { type: 'toggleServerFields' })
    expect(liveWriteReducer(stale, { type: 'confirm', id: 'r' })).toBe(stale)
    // Dependents of an earlier dialog never land in a later one.
    const later = run([{ type: 'close' }, { type: 'open', op: del, replicas: '' }], withDeps)
    expect(liveWriteReducer(later, { type: 'dependents', opened: withDeps.dialog!.opened, result: { ok: true, dependents: deps } })).toBe(later)
  })
})

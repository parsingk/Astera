import { describe, it, expect } from 'vitest'
import type {
  KubeContexts,
  KubePreview,
  KubeRequest,
  KubeRunResult,
  KubeTargetView,
  ResourceDiff,
  ResourceState
} from '../../../core/kube/types'
import {
  canConfirm,
  compareCounts,
  displayTarget,
  initialKubeOps,
  kubeOpsReducer,
  kubeRequestOf,
  kubeScope,
  touchesSelection,
  type KubeOpsAction,
  type KubeOpsState
} from './useKubeOps'

const REQ: KubeRequest = { selection: ['/p/k8s/a.yaml'], projectRoot: '/p', context: 'kind-dev', pill: 'dev' }

const diff = (ref: string, state: ResourceState): ResourceDiff => ({
  ref,
  kind: 'ConfigMap',
  name: ref,
  namespace: 'dev',
  state,
  before: '',
  after: '',
  rows: [],
  changedLines: state === 'changed' ? 2 : 0
})

const LINES = [['apply', '-f', '/p/k8s/a.yaml', '--context', 'kind-dev']]

const okPreview = (fingerprint = 'fp1', states: ResourceState[] = ['changed']): KubePreview => ({
  ok: true,
  plan: { ok: true, commands: [{ kind: 'files', files: ['/p/k8s/a.yaml'] }], leftOut: [] },
  commandLines: LINES,
  resources: states.map((s, i) => ({ command: 0, diff: diff(`cm/${i}`, s) })),
  fingerprint
})

const runResult = (fields: Partial<KubeRunResult> = {}): KubeRunResult => ({
  id: 'run1',
  verb: 'apply',
  context: 'kind-dev',
  commandLines: [['apply']],
  ran: 1,
  outcomes: [{ ref: 'configmap/a', outcome: 'configured' }],
  ok: true,
  stderr: '',
  startedAt: 10,
  finishedAt: 20,
  ...fields
})

const step = (s: KubeOpsState, ...actions: KubeOpsAction[]): KubeOpsState => actions.reduce(kubeOpsReducer, s)

const open = (verb: 'compare' | 'apply' | 'delete' = 'apply'): KubeOpsState =>
  step(initialKubeOps, { type: 'preview', verb, req: REQ, namespaceLabel: 'dev', id: 'd1', at: 5 })

describe('kubeOpsReducer: the apply flow', () => {
  it('preview opens the dialog loading, previewed shows it, confirm closes it with a running entry, ran makes it done', () => {
    const s1 = open()
    expect(s1.dialog).toMatchObject({ verb: 'apply', preview: null, stale: false, keepServerFields: false, phase: 'previewing' })
    expect(canConfirm(s1.dialog)).toBe(false)

    const s2 = step(s1, { type: 'previewed', seq: s1.dialog!.seq, preview: okPreview(), scope: '1 file' })
    expect(s2.dialog).toMatchObject({ phase: 'confirming', stale: false })
    expect(s2.dialog!.preview).toEqual(okPreview())
    expect(canConfirm(s2.dialog)).toBe(true)
    expect(s2.log).toEqual([]) // an apply logs when it runs, not when it is previewed

    const s3 = step(s2, { type: 'confirm', id: 'run1', at: 10, scope: '1 file' })
    expect(s3.dialog).toBeNull()
    expect(s3.log).toEqual([
      {
        id: 'run1',
        verb: 'apply',
        context: 'kind-dev',
        scope: '1 file',
        commandLines: LINES,
        startedAt: 10,
        state: 'running'
      }
    ])

    const result = runResult()
    const s4 = step(s3, { type: 'ran', result, reopen: s2.dialog! })
    expect(s4.dialog).toBeNull()
    expect(s4.log).toHaveLength(1)
    expect(s4.log[0]).toMatchObject({ id: 'run1', state: 'done', result })
  })

  it('confirm does nothing while loading, while stale, for a failed preview, or for a compare', () => {
    const loading = open()
    expect(step(loading, { type: 'confirm', id: 'r', at: 1, scope: '' })).toBe(loading)

    const shown = step(loading, { type: 'previewed', seq: loading.dialog!.seq, preview: okPreview(), scope: '' })
    const stale = step(shown, { type: 'fileChanged' })
    expect(step(stale, { type: 'confirm', id: 'r', at: 1, scope: '' })).toBe(stale)

    const failed = step(loading, {
      type: 'previewed',
      seq: loading.dialog!.seq,
      preview: { ok: false, reason: 'kubectl', commandLines: [], stderr: 'dry run failed: boom' },
      scope: ''
    })
    expect(canConfirm(failed.dialog)).toBe(false)
    expect(step(failed, { type: 'confirm', id: 'r', at: 1, scope: '' })).toBe(failed)

    const cmp = open('compare')
    const cmpShown = step(cmp, { type: 'previewed', seq: cmp.dialog!.seq, preview: okPreview(), scope: '' })
    expect(canConfirm(cmpShown.dialog)).toBe(false)
    const after = step(cmpShown, { type: 'confirm', id: 'r', at: 1, scope: '' })
    expect(after).toBe(cmpShown)
  })

  it('watches the selection for disk changes, or the paths the caller names (a patch beside its overlay)', () => {
    expect(open().dialog!.watch).toEqual(REQ.selection)
    const s = step(initialKubeOps, {
      type: 'preview',
      verb: 'apply',
      req: { ...REQ, selection: ['/p/envs/prod'] },
      namespaceLabel: 'dev',
      id: 'd1',
      at: 5,
      watch: ['/p/base/patch.yaml', '/p/envs/prod']
    })
    expect(s.dialog!.watch).toEqual(['/p/base/patch.yaml', '/p/envs/prod'])
  })

  it('newest log entry first', () => {
    const a = step(open(), { type: 'previewed', seq: 1, preview: okPreview(), scope: 'a' }, { type: 'confirm', id: 'r1', at: 1, scope: 'a' })
    const b = step(
      a,
      { type: 'preview', verb: 'delete', req: REQ, namespaceLabel: 'dev', id: 'd2', at: 2 },
      { type: 'previewed', seq: 2, preview: okPreview(), scope: 'b' },
      { type: 'confirm', id: 'r2', at: 3, scope: 'b' }
    )
    expect(b.log.map((e) => [e.id, e.verb])).toEqual([
      ['r2', 'delete'],
      ['r1', 'apply']
    ])
  })
})

describe('kubeOpsReducer: a disk change while the dialog is open', () => {
  it('while confirming: stale, back to previewing with a new ask, the old diff kept until the new one arrives', () => {
    const s1 = open()
    const s2 = step(s1, { type: 'previewed', seq: s1.dialog!.seq, preview: okPreview('fp1'), scope: '' })
    const s3 = step(s2, { type: 'fileChanged' })
    expect(s3.dialog).toMatchObject({ phase: 'previewing', stale: true })
    expect(s3.dialog!.preview).toEqual(okPreview('fp1'))
    expect(s3.dialog!.seq).toBeGreaterThan(s2.dialog!.seq)
    expect(canConfirm(s3.dialog)).toBe(false)

    // the answer to the earlier ask is dropped; the new one clears stale
    const late = step(s3, { type: 'previewed', seq: s2.dialog!.seq, preview: okPreview('old'), scope: '' })
    expect(late).toBe(s3)
    const s4 = step(s3, { type: 'previewed', seq: s3.dialog!.seq, preview: okPreview('fp2'), scope: '' })
    expect(s4.dialog).toMatchObject({ phase: 'confirming', stale: false })
    expect((s4.dialog!.preview as Extract<KubePreview, { ok: true }>).fingerprint).toBe('fp2')
    expect(canConfirm(s4.dialog)).toBe(true)
  })

  it('while the first answer is awaited: asks again, and the first answer is dropped', () => {
    const s1 = open()
    const s2 = step(s1, { type: 'fileChanged' })
    expect(s2.dialog!.seq).toBeGreaterThan(s1.dialog!.seq)
    expect(s2.dialog).toMatchObject({ phase: 'previewing', preview: null })
    expect(step(s2, { type: 'previewed', seq: s1.dialog!.seq, preview: okPreview(), scope: '' })).toBe(s2)
  })

  it('with no dialog open nothing happens', () => {
    expect(step(initialKubeOps, { type: 'fileChanged' })).toBe(initialKubeOps)
  })
})

describe('kubeOpsReducer: a run refused because the selection changed', () => {
  it('reopens the dialog in previewing, stale, with a new ask; the entry is done with the refusal', () => {
    const s1 = open()
    const s2 = step(s1, { type: 'previewed', seq: s1.dialog!.seq, preview: okPreview('fp1'), scope: '' })
    const confirmed = s2.dialog!
    const s3 = step(s2, { type: 'confirm', id: 'run1', at: 10, scope: '' })
    const result = runResult({ ok: false, ran: 0, outcomes: [], refused: { reason: 'changed' } })
    const s4 = step(s3, { type: 'ran', result, reopen: confirmed })
    expect(s4.dialog).toMatchObject({ verb: 'apply', req: REQ, phase: 'previewing', stale: true })
    expect(s4.dialog!.seq).toBeGreaterThan(s2.dialog!.seq)
    expect(s4.log[0]).toMatchObject({ id: 'run1', state: 'done', result })
    expect(canConfirm(s4.dialog)).toBe(false)
  })

  it('does not replace a dialog the person opened since', () => {
    const s2 = step(open(), { type: 'previewed', seq: 1, preview: okPreview(), scope: '' })
    const confirmed = s2.dialog!
    const s3 = step(
      s2,
      { type: 'confirm', id: 'run1', at: 10, scope: '' },
      { type: 'preview', verb: 'delete', req: REQ, namespaceLabel: 'dev', id: 'd2', at: 11 }
    )
    const s4 = step(s3, { type: 'ran', result: runResult({ ok: false, ran: 0, refused: { reason: 'changed' } }), reopen: confirmed })
    expect(s4.dialog).toBe(s3.dialog)
    expect(s4.log[0].state).toBe('done')
  })

  it('any other refusal only ends the entry, carrying it', () => {
    const s2 = step(open(), { type: 'previewed', seq: 1, preview: okPreview(), scope: '' })
    const refused: KubeRunResult['refused'] = { ok: false, reason: 'mixed-contexts', folders: ['/p/a', '/p/b'] }
    const result = runResult({ ok: false, ran: 0, outcomes: [], refused })
    const s4 = step(s2, { type: 'confirm', id: 'run1', at: 10, scope: '' }, { type: 'ran', result, reopen: s2.dialog! })
    expect(s4.dialog).toBeNull()
    expect(s4.log[0]).toMatchObject({ state: 'done', result: { refused } })
  })
})

describe('kubeOpsReducer: close and the server fields toggle', () => {
  it('close works while loading, while shown and after a reopen; a late answer after close is dropped', () => {
    const loading = open()
    const closed = step(loading, { type: 'close' })
    expect(closed.dialog).toBeNull()
    expect(step(closed, { type: 'previewed', seq: loading.dialog!.seq, preview: okPreview(), scope: '' })).toBe(closed)

    const shown = step(open(), { type: 'previewed', seq: 1, preview: okPreview(), scope: '' })
    expect(step(shown, { type: 'close' }).dialog).toBeNull()

    const reopened = step(
      shown,
      { type: 'confirm', id: 'r', at: 1, scope: '' },
      { type: 'ran', result: runResult({ ok: false, ran: 0, refused: { reason: 'changed' } }), reopen: shown.dialog! }
    )
    expect(reopened.dialog).not.toBeNull()
    expect(step(reopened, { type: 'close' }).dialog).toBeNull()
    expect(step(initialKubeOps, { type: 'close' })).toBe(initialKubeOps)
  })

  it('toggling server fields flips the flag and asks again, loading', () => {
    const s1 = open()
    const s2 = step(s1, { type: 'previewed', seq: s1.dialog!.seq, preview: okPreview(), scope: '' })
    const s3 = step(s2, { type: 'toggleServerFields' })
    expect(s3.dialog).toMatchObject({ keepServerFields: true, preview: null, phase: 'previewing', stale: false })
    expect(s3.dialog!.seq).toBeGreaterThan(s2.dialog!.seq)
    const s4 = step(s3, { type: 'toggleServerFields' })
    expect(s4.dialog!.keepServerFields).toBe(false)
    expect(step(initialKubeOps, { type: 'toggleServerFields' })).toBe(initialKubeOps)
  })
})

describe('kubeOpsReducer: compare and reload entries', () => {
  it('a compare logs one done entry with its counts, updated by a later preview, and stays open read-only', () => {
    const s1 = open('compare')
    const s2 = step(s1, {
      type: 'previewed',
      seq: s1.dialog!.seq,
      preview: okPreview('fp', ['changed', 'unchanged', 'unchanged', 'new']),
      scope: '1 file'
    })
    expect(s2.dialog).toMatchObject({ verb: 'compare', phase: 'confirming' })
    expect(s2.log).toEqual([
      {
        id: 'd1',
        verb: 'compare',
        context: 'kind-dev',
        scope: '1 file',
        commandLines: LINES,
        startedAt: 5,
        state: 'done',
        compare: { changed: 1, unchanged: 2, created: 1 }
      }
    ])
    const s3 = step(s2, { type: 'fileChanged' })
    const s4 = step(s3, { type: 'previewed', seq: s3.dialog!.seq, preview: okPreview('fp', ['unchanged']), scope: '1 file' })
    expect(s4.log).toHaveLength(1)
    expect(s4.log[0].compare).toEqual({ changed: 0, unchanged: 1, created: 0 })
  })

  it('a failed compare preview logs nothing; the dialog shows the failure', () => {
    const s1 = open('compare')
    const s2 = step(s1, {
      type: 'previewed',
      seq: s1.dialog!.seq,
      preview: { ok: false, reason: 'kubectl', commandLines: [], stderr: 'unreachable' },
      scope: ''
    })
    expect(s2.log).toEqual([])
    expect(s2.dialog!.phase).toBe('confirming')
  })

  it('a reload is a running entry, then done with its result; clear empties the log', () => {
    const s1 = step(initialKubeOps, { type: 'reload', id: 'rl', context: 'kind-dev', scope: '/p/k8s/a.yaml', at: 3 })
    expect(s1.log).toEqual([
      { id: 'rl', verb: 'reload', context: 'kind-dev', scope: '/p/k8s/a.yaml', commandLines: [], startedAt: 3, state: 'running' }
    ])
    const result = runResult({ id: 'rl', verb: 'reload', commandLines: [] })
    const s2 = step(s1, { type: 'ran', result })
    expect(s2.log[0]).toMatchObject({ state: 'done', result })
    expect(step(s2, { type: 'clear' }).log).toEqual([])
  })

  it('a result for an entry that was cleared adds nothing back', () => {
    const s1 = step(initialKubeOps, { type: 'reload', id: 'rl', context: 'c', scope: 'x', at: 1 }, { type: 'clear' })
    expect(step(s1, { type: 'ran', result: runResult({ id: 'rl' }) }).log).toEqual([])
  })
})

const view = (over: Partial<KubeTargetView> = {}): KubeTargetView => ({
  state: { state: 'current', context: 'kind-dev', namespace: 'dev' },
  rememberFolder: '/p/k8s',
  overlay: null,
  overlays: [],
  lockedNamespace: null,
  rememberChoices: ['/p/k8s', '/p'],
  reloadBlocked: null,
  nsFromFile: false,
  ...over
})

const CONTEXTS: KubeContexts = {
  current: 'kind-dev',
  contexts: [
    { name: 'kind-dev', namespace: 'dev', cluster: 'kind-dev', provider: null },
    { name: 'prod', namespace: null, cluster: 'prod', provider: null },
    { name: 'stage', namespace: 'web', cluster: 'stage', provider: null }
  ]
}

describe('kubeRequestOf: the target and the namespace pill', () => {
  const sel = ['/p/k8s/a.yaml']
  const remembered = view({ state: { state: 'remembered', context: 'prod', namespace: 'shop', folder: '/p/k8s' } })

  it('takes the context from a remembered or current target', () => {
    expect(kubeRequestOf(sel, '/p', remembered, undefined, CONTEXTS)).toEqual({
      selection: sel,
      projectRoot: '/p',
      context: 'prod',
      pill: 'shop'
    })
    expect(kubeRequestOf(sel, '/p', view(), undefined, CONTEXTS)).toMatchObject({ context: 'kind-dev', pill: 'dev' })
  })

  it('pill: the remembered namespace, else the override, else the context namespace, else default', () => {
    expect(kubeRequestOf(sel, '/p', remembered, { namespace: 'other' }, CONTEXTS)?.pill).toBe('shop')
    const noNs = view({ state: { state: 'remembered', context: 'prod', namespace: null, folder: '/p/k8s' } })
    expect(kubeRequestOf(sel, '/p', noNs, { namespace: 'other' }, CONTEXTS)?.pill).toBe('other')
    expect(kubeRequestOf(sel, '/p', view({ state: { state: 'remembered', context: 'stage', namespace: null, folder: '/p' } }), undefined, CONTEXTS)?.pill).toBe('web')
    expect(kubeRequestOf(sel, '/p', noNs, undefined, CONTEXTS)?.pill).toBe('default')
    expect(kubeRequestOf(sel, '/p', noNs, undefined, null)?.pill).toBe('default')
  })

  it('a session override of the context wins, and the remembered namespace (of another context) is not used', () => {
    expect(kubeRequestOf(sel, '/p', remembered, { context: 'stage' }, CONTEXTS)).toMatchObject({ context: 'stage', pill: 'web' })
    expect(kubeRequestOf(sel, '/p', remembered, { context: 'stage', namespace: 'x' }, CONTEXTS)).toMatchObject({
      context: 'stage',
      pill: 'x'
    })
    expect(kubeRequestOf(sel, '/p', view({ state: { state: 'none' } }), { context: 'prod' }, CONTEXTS)).toMatchObject({
      context: 'prod',
      pill: 'default'
    })
  })

  it('no request without a context, or through an overlay not picked yet', () => {
    expect(kubeRequestOf(sel, '/p', view({ state: { state: 'none' } }), undefined, CONTEXTS)).toBeNull()
    expect(kubeRequestOf(sel, '/p', view({ state: { state: 'missing', context: 'gone', folder: '/p/k8s' } }), undefined, CONTEXTS)).toBeNull()
    const unpicked = view({ state: { state: 'none' }, overlays: ['/p/envs/dev', '/p/envs/prod'], overlay: null })
    expect(kubeRequestOf(sel, '/p', unpicked, { context: 'prod' }, CONTEXTS)).toBeNull()
  })

  it('displayTarget shows a session override as a plain choice, else the target as it is', () => {
    expect(displayTarget(view(), undefined)).toEqual(view().state)
    expect(displayTarget(view(), { namespace: 'x' })).toEqual(view().state)
    expect(displayTarget(view({ state: { state: 'none' } }), { context: 'prod' })).toMatchObject({ state: 'remembered', context: 'prod' })
  })
})

describe('touchesSelection: a disk change and what the dialog shows', () => {
  it('matches a selected file and anything under a selected folder, POSIX', () => {
    const sel = ['/p/k8s/a.yaml', '/p/apps']
    expect(touchesSelection('/p/k8s/a.yaml', sel, 'linux')).toBe(true)
    expect(touchesSelection('/p/apps/web/dep.yaml', sel, 'linux')).toBe(true)
    expect(touchesSelection('/p/apps', sel, 'linux')).toBe(true)
    expect(touchesSelection('/p/k8s/b.yaml', sel, 'linux')).toBe(false)
    expect(touchesSelection('/p/apps-old/x.yaml', sel, 'linux')).toBe(false) // a prefix that is not a folder boundary
    expect(touchesSelection('/p/K8s/a.yaml', sel, 'linux')).toBe(false) // linux keeps case
  })

  it('matches across separators and letter case on Windows, and a trailing separator on a folder', () => {
    const sel = ['C:\\p\\k8s\\a.yaml', 'C:\\p\\apps\\']
    expect(touchesSelection('C:\\p\\k8s\\a.yaml', sel, 'win32')).toBe(true)
    expect(touchesSelection('c:/P/K8S/A.yaml', sel, 'win32')).toBe(true)
    expect(touchesSelection('C:\\p\\apps\\web\\dep.yaml', sel, 'win32')).toBe(true)
    expect(touchesSelection('C:\\p\\apps2\\dep.yaml', sel, 'win32')).toBe(false)
    expect(touchesSelection('C:\\p\\k8s\\b.yaml', sel, 'win32')).toBe(false)
  })
})

describe('compareCounts and kubeScope', () => {
  it('counts changed, unchanged and new resources', () => {
    const p = okPreview('fp', ['changed', 'new', 'unchanged', 'changed', 'new', 'new']) as Extract<KubePreview, { ok: true }>
    expect(compareCounts(p)).toEqual({ changed: 2, unchanged: 1, created: 3 })
  })

  it('the scope is the overlay of a single overlay command, else the number of files and overlays', () => {
    expect(kubeScope({ ok: true, commands: [{ kind: 'overlay', dir: '/p/envs/prod' }], leftOut: [] })).toEqual({ overlay: '/p/envs/prod' })
    expect(
      kubeScope({
        ok: true,
        commands: [
          { kind: 'files', files: ['/p/a.yaml', '/p/b.yaml'] },
          { kind: 'overlay', dir: '/p/envs/prod' }
        ],
        leftOut: []
      })
    ).toEqual({ files: 3 })
  })
})

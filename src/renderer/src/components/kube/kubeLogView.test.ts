import { describe, it, expect } from 'vitest'
import type { KubeRequest, KubeRunResult } from '../../../../core/kube/types'
import { normKubePath, type KubeLogEntry } from '../../hooks/useKubeOps'
import { defaultExpandedId, failedFiles, kubeBadge, kubeFailureCount, kubeToastOf, nextFailedPaths } from './kubeLogView'

const t = (key: string, p?: Record<string, unknown>): string => (p ? `${key}${JSON.stringify(p)}` : key)
const REQ: KubeRequest = { selection: ['/p/k8s'], projectRoot: '/p', context: 'c', pill: null }
const result = (over: Partial<KubeRunResult> = {}): KubeRunResult => ({
  id: 'r', verb: 'apply', context: 'c', commandLines: [], ran: 1, outcomes: [], ok: true, stderr: '', startedAt: 1, finishedAt: 2, ...over
})
const entry = (over: Partial<KubeLogEntry> = {}): KubeLogEntry => ({
  id: 'e', verb: 'apply', context: 'c', scope: 's', commandLines: [], startedAt: 0, state: 'done', req: REQ, namespaceLabel: 'n', ...over
})
const err = (file?: string, message = 'bad') => ({ ref: '', outcome: 'error' as const, file, message })

describe('kubeBadge', () => {
  it('maps each state of an entry', () => {
    expect(kubeBadge(entry({ state: 'running' }))).toEqual({ kind: 'running' })
    expect(kubeBadge(entry({ compare: { changed: 1, unchanged: 0, created: 0 } }))).toEqual({ kind: 'done' })
    expect(kubeBadge(entry({ result: result() }))).toEqual({ kind: 'done' })
    expect(kubeBadge(entry({ result: result({ ok: false, outcomes: [err('a'), err('b')] }) }))).toEqual({ kind: 'failed', count: 2 })
    expect(kubeBadge(entry({ result: result({ ok: false, stderr: 'x' }) }))).toEqual({ kind: 'failed', count: 1 })
    expect(kubeBadge(entry({ result: result({ ok: false, cancelled: true }) }))).toEqual({ kind: 'cancelled' })
    expect(kubeBadge(entry({ result: result({ ok: false, timedOut: true }) }))).toEqual({ kind: 'timedOut' })
    expect(kubeBadge(entry({ result: result({ ok: false, refused: { reason: 'changed' } }) }))).toEqual({ kind: 'refused' })
  })
})

describe('log ordering and counts', () => {
  it('expands the newest finished entry (the log is newest first)', () => {
    expect(defaultExpandedId([entry({ id: 'a', state: 'running' }), entry({ id: 'b' }), entry({ id: 'c' })])).toBe('b')
    expect(defaultExpandedId([])).toBeNull()
  })
  it('counts finished entries that failed', () => {
    const bad = entry({ result: result({ ok: false }) })
    expect(kubeFailureCount([bad, entry({ result: result() }), entry({ state: 'running' }), bad])).toBe(2)
  })
})

describe('failed paths', () => {
  it('resolves a relative error file against the project root and keeps an absolute one', () => {
    expect(failedFiles(result({ ok: false, outcomes: [err('k8s/a.yaml'), err('/x/b.yaml'), err(undefined)] }), '/p')).toEqual([
      '/p/k8s/a.yaml',
      '/x/b.yaml'
    ])
  })
  it('a failed run adds its error files and keeps every earlier mark', () => {
    const prev = new Set(['/p/k8s/old.yaml', '/p/k8s/a.yaml', '/other/z.yaml'])
    const next = nextFailedPaths(prev, result({ ok: false, outcomes: [err('/p/k8s/a.yaml'), err('/p/k8s/new.yaml')] }), REQ)
    expect([...next].sort()).toEqual(['/other/z.yaml', '/p/k8s/a.yaml', '/p/k8s/new.yaml', '/p/k8s/old.yaml'])
  })
  it('a whole-run failure naming no file neither adds nor removes marks', () => {
    const prev = new Set(['/p/k8s/a.yaml'])
    const next = nextFailedPaths(prev, result({ ok: false, stderr: 'Unable to connect to the server', outcomes: [err(undefined)] }), REQ)
    expect([...next]).toEqual(['/p/k8s/a.yaml'])
  })
  it('a successful run that errored on one file clears the others of its selection', () => {
    const prev = new Set(['/p/k8s/old.yaml', '/p/k8s/a.yaml'])
    const next = nextFailedPaths(prev, result({ ok: true, outcomes: [err('/p/k8s/a.yaml')] }), REQ)
    expect([...next]).toEqual(['/p/k8s/a.yaml'])
  })
  it('keys marks by the normalised path, so a differently written path finds them', () => {
    const bs = String.fromCharCode(92)
    expect(normKubePath(`C:${bs}proj${bs}a.yaml`, 'win32')).toBe(normKubePath('c:/proj/a.yaml', 'win32'))
    const next = nextFailedPaths(new Set(), result({ ok: false, outcomes: [err(`/p/k8s${bs}a.yaml`)] }), REQ)
    expect(next.has(normKubePath('/p/k8s/a.yaml'))).toBe(true)
  })
  it('a successful run clears its selection only', () => {
    const next = nextFailedPaths(new Set(['/p/k8s/a.yaml', '/other/z.yaml']), result(), REQ)
    expect([...next]).toEqual(['/other/z.yaml'])
  })
  it('a refused run changes nothing; a cancelled one only adds', () => {
    const prev = new Set(['/p/k8s/a.yaml'])
    expect([...nextFailedPaths(prev, result({ ok: false, refused: { reason: 'changed' } }), REQ)]).toEqual(['/p/k8s/a.yaml'])
    expect([...nextFailedPaths(prev, result({ ok: false, cancelled: true, outcomes: [err('/p/k8s/b.yaml')] }), REQ)].sort()).toEqual([
      '/p/k8s/a.yaml',
      '/p/k8s/b.yaml'
    ])
  })
})

describe('kubeToastOf', () => {
  it('words success per verb', () => {
    expect(kubeToastOf(result(), t as never)).toEqual({ kind: 'success', message: 'kube.toast.applied{"context":"c"}' })
    expect(kubeToastOf(result({ verb: 'delete' }), t as never)?.message).toBe('kube.toast.deleted{"context":"c"}')
    expect(kubeToastOf(result({ verb: 'reload' }), t as never)?.message).toBe('kube.toast.reloaded{"context":"c"}')
  })
  it('reports the counts of a partial failure', () => {
    const r = result({ ok: false, outcomes: [{ ref: 'a/b', outcome: 'created' }, { ref: 'c/d', outcome: 'unchanged' }, err('/f')] })
    const note = kubeToastOf(r, t as never)
    expect(note?.kind).toBe('error')
    expect(note?.message).toContain('kube.toast.partial')
    expect(note?.message).toContain('"ok":2')
    expect(note?.message).toContain('"failed":1')
  })
  it('has its own wording for timeout, stop and refusal, and stays silent where the dialog or another toast speaks', () => {
    expect(kubeToastOf(result({ ok: false, timedOut: true }), t as never)?.message).toContain('timedOut')
    expect(kubeToastOf(result({ ok: false, cancelled: true }), t as never)?.message).toContain('cancelled')
    expect(kubeToastOf(result({ ok: false, refused: { ok: false, reason: 'mixed-contexts', folders: [] } }), t as never)?.message).toContain('refused')
    expect(kubeToastOf(result({ ok: false, refused: { reason: 'changed' } }), t as never)).toBeNull()
    expect(kubeToastOf(result({ ok: false, verb: 'reload' }), t as never)).toBeNull()
  })
})

import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { KubePreview, ResourceDiff } from '../../../../core/kube/types'
import { KubeConfirmDialog } from './KubeConfirmDialog'

vi.mock('../../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    t: (key: string, p?: Record<string, unknown>) =>
      p ? `${key}${JSON.stringify(p)}` : key,
    tm: (m: unknown) => String(m)
  })
}))

const diff = (over: Partial<ResourceDiff> = {}): ResourceDiff => ({
  ref: 'Deployment/web',
  kind: 'Deployment',
  name: 'web',
  namespace: 'shop',
  state: 'changed',
  before: 'a',
  after: 'b',
  rows: [
    { kind: 'del', text: 'replicas: 1', oldNo: 1 },
    { kind: 'add', text: 'replicas: 3', newNo: 1 }
  ],
  changedLines: 2,
  ...over
})

const okPreview = (d: ResourceDiff = diff()): KubePreview => ({
  ok: true,
  plan: { ok: true, commands: [{ kind: 'files', files: ['/p/a.yaml'] }], leftOut: [{ path: '/p/x.yaml', reason: 'helm' }] },
  commandLines: [['apply', '--context', 'prod', '-f', '/p/a.yaml']],
  resources: [{ command: 0, diff: d }],
  fingerprint: 'fp'
})

const render = (preview: KubePreview | null, over: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(
    React.createElement(KubeConfirmDialog, {
      verb: 'apply',
      context: 'prod',
      namespaceLabel: 'shop',
      preview,
      keepServerFields: false,
      onToggleServerFields: () => {},
      onConfirm: () => {},
      onCancel: () => {},
      stale: false,
      ...over
    })
  )

describe('KubeConfirmDialog', () => {
  it('a kubectl failure shows stderr and a disabled primary button', () => {
    const html = render({ ok: false, reason: 'kubectl', commandLines: [['apply']], stderr: 'boom: no route', timedOut: true })
    expect(html).toContain('boom: no route')
    expect(html).toContain('kube.confirm.timedOut')
    expect(html).toMatch(/<button[^>]*class="primary"[^>]*disabled/)
  })

  it('an ok preview has the apply button with the context, enabled, and the command line', () => {
    const html = render(okPreview())
    expect(html).toContain('kube.confirm.apply{&quot;context&quot;:&quot;prod&quot;}')
    expect(html).not.toMatch(/<button[^>]*class="primary"[^>]*disabled/)
    expect(html).toContain('$ kubectl apply --context prod -f /p/a.yaml')
    expect(html).toContain('kube.confirm.leftOutReason.helm')
  })

  it('stale disables the primary button; loading shows progress', () => {
    expect(render(okPreview(), { stale: true })).toMatch(/<button[^>]*class="primary"[^>]*disabled/)
    const loading = render(null)
    expect(loading).toContain('kube.confirm.loading')
    expect(loading).toMatch(/<button[^>]*class="primary"[^>]*disabled/)
  })

  it('a delete uses the danger style; compare has no primary button', () => {
    expect(render(okPreview(), { verb: 'delete' })).toContain('class="primary danger"')
    const html = render(okPreview(), { verb: 'compare' })
    expect(html).not.toContain('class="primary')
    expect(html).toContain('common.close')
  })

  it('a too-large resource renders the counts, not lines', () => {
    const html = render(okPreview(diff({ rows: { tooLarge: true, added: 7, removed: 5 } })))
    expect(html).toContain('kube.confirm.tooLarge{&quot;added&quot;:7,&quot;removed&quot;:5}')
    expect(html).not.toContain('replicas')
  })

  it('refusals name their folders and conflicts', () => {
    expect(render({ ok: false, reason: 'mixed-contexts', folders: ['/f1', '/f2'] })).toContain('/f2')
    const ns = render({ ok: false, reason: 'namespace', conflicts: [{ path: '/p/a.yaml', namespace: 'dev' }] })
    expect(ns).toContain('/p/a.yaml')
    expect(ns).toContain('dev')
    expect(render({ ok: false, reason: 'refused', plan: { ok: false, reason: 'base-folder', paths: ['/b'] } })).toContain(
      'kube.confirm.refused.base-folder'
    )
  })
})

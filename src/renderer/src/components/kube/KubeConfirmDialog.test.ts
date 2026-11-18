import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { KubePreview, ResourceDiff } from '../../../../core/kube/types'
import { en } from '../../../../core/i18n/messages/en'
import { ko } from '../../../../core/i18n/messages/ko'
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

const okPreview = (d: ResourceDiff = diff(), nsFlags: (string | null)[] = [null]): KubePreview => ({
  ok: true,
  plan: { ok: true, commands: [{ kind: 'files', files: ['/p/a.yaml'] }], leftOut: [{ path: '/p/x.yaml', reason: 'helm' }] },
  commandLines: [['apply', '--context', 'prod', '-f', '/p/a.yaml']],
  nsFlags,
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
      running: false,
      cancelling: false,
      onAbort: () => {},
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
    const mixedNs = render({ ok: false, reason: 'mixed-namespaces', namespace: 'shop', folders: [{ folder: '/p/web', namespace: 'web' }] })
    expect(mixedNs).toContain('kube.confirm.mixedNamespaces{&quot;ns&quot;:&quot;shop&quot;}')
    expect(mixedNs).toContain('/p/web')
    expect(mixedNs).toContain('web')
    expect(mixedNs).toMatch(/<button[^>]*class="primary"[^>]*disabled/)
  })

  it('a broken kustomization names its folder; a file no kustomization lists is left out with its own words', () => {
    const broken = render({ ok: false, reason: 'refused', plan: { ok: false, reason: 'broken-kustomization', paths: ['/p/apps/app'] } })
    expect(broken).toContain('kube.confirm.refused.broken-kustomization')
    expect(broken).toContain('/p/apps/app')
    const p = okPreview()
    if (!p.ok) throw new Error('unreachable')
    const html = render({ ...p, plan: { ...p.plan, leftOut: [{ path: '/p/app/transformer.yaml', reason: 'unlisted' }] } })
    expect(html).toContain('kube.confirm.leftOutReason.unlisted')
    for (const key of ['kube.confirm.refused.broken-kustomization', 'kube.confirm.leftOutReason.unlisted'] as const) {
      expect(ko[key]).toBeTruthy()
      expect(en[key]).toBeTruthy()
    }
  })

  it('the namespace pill comes from the preview: one value, from the files, or several; the caller label while loading', () => {
    expect(render(null)).toContain('kube.confirm.namespace{&quot;ns&quot;:&quot;shop&quot;}')
    expect(render(okPreview(diff(), ['dev']))).toContain('kube.confirm.namespace{&quot;ns&quot;:&quot;dev&quot;}')
    expect(render(okPreview(diff(), ['dev', 'dev', null]))).toContain('kube.confirm.namespace{&quot;ns&quot;:&quot;dev&quot;}')
    const fromFiles = render(okPreview(diff(), [null, null]))
    expect(fromFiles).toContain('kube.toolbar.nsFromFile')
    expect(fromFiles).not.toContain('kube.confirm.namespace{')
    const many = render(okPreview(diff(), ['dev', null, 'web']))
    expect(many).toContain('kube.confirm.nsMany')
    expect(many).toContain('title="dev, web"')
  })

  it('running: the primary shows progress and is disabled, the other button stops the run', () => {
    const html = render(okPreview(), { running: true })
    expect(html).toMatch(/<button[^>]*class="primary"[^>]*disabled[^>]*><span class="loading-spinner"/)
    expect(html).toContain('kube.confirm.abort')
    expect(html).not.toContain('common.cancel')
    expect(render(okPreview(), { running: true, cancelling: true })).toMatch(/<button[^>]*disabled[^>]*>kube.confirm.abort/)
  })
})

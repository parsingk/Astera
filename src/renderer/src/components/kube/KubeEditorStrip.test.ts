import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { KubeStatus, KubeTargetView } from '../../../../core/kube/types'
import { KubeEditorStrip, resourceLabel } from './KubeEditorStrip'

vi.mock('../../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    t: (key: string, p?: Record<string, unknown>) => (p ? `${key}${JSON.stringify(p)}` : key),
    tm: (m: unknown) => String(m)
  })
}))

const VIEW: KubeTargetView = {
  state: { state: 'current', context: 'kind-dev', namespace: 'dev' },
  rememberFolder: '/p/k8s',
  overlay: null,
  overlays: [],
  lockedNamespace: null,
  rememberChoices: ['/p/k8s', '/p'],
  reloadBlocked: null,
  nsFromFile: false,
  resource: null,
  brokenKustomization: null,
  unlisted: false,
  helmChart: false
}

/** The strip as App renders it, over a stand-in for useKubeEditor's answer. */
const strip = (view: Partial<KubeTargetView>, status: KubeStatus | null = null, kind: 'manifest' | 'kustomization' = 'manifest'): string =>
  renderToStaticMarkup(
    React.createElement(KubeEditorStrip, {
      path: '/p/k8s/a.yaml',
      kind,
      projectRoot: '/p',
      busy: false,
      onOpenSettings: () => {},
      editor: {
        entries: { '/p/k8s/a.yaml': { view: { ...VIEW, ...view }, status, statusLoading: false } },
        overrideOf: () => undefined,
        contexts: null,
        picker: null,
        kubectlMissing: false,
        renderOpen: () => false
      } as never
    })
  )

describe('KubeEditorStrip', () => {
  it("a Kustomize file's kind chip counts the overlay's resources from the latest status", () => {
    const k = { overlays: ['/p/envs/prod'], overlay: '/p/envs/prod', resource: { overlay: true as const } }
    const html = strip(k, { kind: 'same', resourceCount: 4 }, 'kustomization')
    expect(html).toContain('<span class="kube-chip kube-chip-kind">kube.chip.resources{&quot;count&quot;:4}</span>')
    expect(strip(k, null, 'kustomization')).not.toContain('kube-chip-kind')
  })

  it("disables a file's actions when the target view says no kustomization beside it lists it", () => {
    const html = strip({ unlisted: true })
    expect(html).toMatch(/<button[^>]*aria-label="kube.toolbar.apply"[^>]*disabled/)
    expect(html).toContain('kube.toolbar.unlisted')
    expect(strip({})).not.toMatch(/<button[^>]*aria-label="kube.toolbar.apply"[^>]*disabled/)
  })
})

const count = (n: number): string => `${n} resources`

describe('resourceLabel: the kind-and-name chip', () => {
  it('names one resource, counts several, counts what an overlay renders once known, and nothing without a resource', () => {
    expect(resourceLabel({ kind: 'Deployment', name: 'api-server' }, count)).toBe('Deployment · api-server')
    expect(resourceLabel({ kind: 'Job', name: null }, count)).toBe('Job')
    expect(resourceLabel({ count: 3 }, count)).toBe('3 resources')
    // through an overlay: the latest status's rendered count, never the overlay's folder name (the overlay pill shows it)
    expect(resourceLabel({ overlay: true as const }, count, { kind: 'same', resourceCount: 4 })).toBe('4 resources')
    expect(resourceLabel({ overlay: true as const }, count, { kind: 'unknown', reason: 'no-target' })).toBeNull()
    expect(resourceLabel({ overlay: true as const }, count, null)).toBeNull()
    expect(resourceLabel({ overlay: true as const }, count)).toBeNull()
    expect(resourceLabel(null, count)).toBeNull()
  })
})

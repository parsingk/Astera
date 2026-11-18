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
  unlisted: false
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
  it("disables a file's actions when the target view says no kustomization beside it lists it", () => {
    const html = strip({ unlisted: true })
    expect(html).toMatch(/<button[^>]*aria-label="kube.toolbar.apply"[^>]*disabled/)
    expect(html).toContain('kube.toolbar.unlisted')
    expect(strip({})).not.toMatch(/<button[^>]*aria-label="kube.toolbar.apply"[^>]*disabled/)
  })
})

const count = (n: number): string => `${n} resources`

describe('resourceLabel: the kind-and-name chip', () => {
  it('names one resource, counts several, shows the overlay folder, and nothing without a resource', () => {
    expect(resourceLabel({ kind: 'Deployment', name: 'api-server' }, count)).toBe('Deployment · api-server')
    expect(resourceLabel({ kind: 'Job', name: null }, count)).toBe('Job')
    expect(resourceLabel({ count: 3 }, count)).toBe('3 resources')
    expect(resourceLabel({ overlay: 'prod' }, count)).toBe('prod')
    expect(resourceLabel(null, count)).toBeNull()
  })
})

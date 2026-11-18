import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { KubeToolbar, StatusChip } from './KubeToolbar'

vi.mock('../../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    t: (key: string, p?: Record<string, unknown>) => (p ? `${key}${JSON.stringify(p)}` : key),
    tm: (m: unknown) => String(m)
  })
}))

const noop = (): void => {}
const base = {
  kind: 'manifest' as const,
  target: { state: 'remembered', context: 'kind-dev', namespace: 'dev', folder: '/p/k8s' } as never,
  overlays: [] as string[],
  overlay: null as string | null,
  pill: 'dev' as string | null,
  nsLocked: null as string | null,
  nsFromFile: false,
  status: null,
  statusLoading: false,
  resourceLabel: null as string | null,
  busy: false,
  kubectlMissing: false,
  reloadBlocked: null,
  brokenKustomization: null as string | null,
  unlisted: false,
  renderOpen: false,
  onPickContext: noop,
  onPickNamespace: noop,
  onPickOverlay: noop,
  onCompare: noop,
  onApply: noop,
  onReload: noop,
  onDelete: noop,
  onToggleRender: noop,
  onOpenSettings: noop
}

const render = (over: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(React.createElement(KubeToolbar, { ...base, ...over } as never))

const button = (html: string, label: string): string => {
  const m = new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(html)
  if (!m) throw new Error(`no button ${label}`)
  return m[0]
}

describe('KubeToolbar plain manifest', () => {
  it('has four icon buttons whose title equals the aria-label, and no eye', () => {
    const html = render()
    for (const k of ['compare', 'apply', 'reload', 'delete']) {
      const b = button(html, `kube.toolbar.${k}`)
      expect(b).toContain(`title="kube.toolbar.${k}"`)
      expect(b).not.toContain('disabled')
    }
    expect(html).not.toContain('kube.toolbar.renderedView')
    expect(html).not.toContain('kube.toolbar.kustomizeNote')
  })

  it('marks apply as the primary button', () => {
    expect(button(render(), 'kube.toolbar.apply')).toContain('kube-primary')
  })

  it('shows the context and namespace pills', () => {
    const html = render()
    expect(html).toContain('kind-dev')
    expect(html).toContain('kube.toolbar.ns{&quot;ns&quot;:&quot;dev&quot;}')
  })
})

describe('target states', () => {
  it('current shows the fallback label in the warning tint', () => {
    const html = render({ target: { state: 'current', context: 'kind-dev', namespace: null } })
    expect(html).toContain('kube.toolbar.currentFallback{&quot;name&quot;:&quot;kind-dev&quot;}')
    expect(html).toContain('kube-pill-warn')
    expect(button(html, 'kube.toolbar.apply')).not.toContain('disabled')
  })

  it('missing names the cluster and disables every action', () => {
    const html = render({ target: { state: 'missing', context: 'gone', folder: '/p/k8s' } })
    expect(html).toContain('kube.toolbar.missing{&quot;name&quot;:&quot;gone&quot;}')
    for (const k of ['compare', 'apply', 'reload', 'delete']) expect(button(html, `kube.toolbar.${k}`)).toContain('disabled')
  })

  it('none asks for a cluster and disables every action', () => {
    const html = render({ target: { state: 'none' } })
    expect(html).toContain('kube.toolbar.chooseCluster')
    for (const k of ['compare', 'apply', 'reload', 'delete']) expect(button(html, `kube.toolbar.${k}`)).toContain('disabled')
  })

  it('busy disables the actions too', () => {
    expect(button(render({ busy: true }), 'kube.toolbar.apply')).toContain('disabled')
  })

  it('shortens an EKS context name for the pill and keeps the full name as the tooltip', () => {
    const arn = 'arn:aws:eks:us-east-1:123456789012:cluster/prod'
    const html = render({ target: { state: 'remembered', context: arn, namespace: null, folder: '/p' } })
    expect(html).toContain('>prod<')
    expect(html).toContain(`title="${arn}"`)
  })
})

describe('reload', () => {
  it('is disabled with its own tooltip for a Secret and for a multi-resource file', () => {
    const secret = button(render({ reloadBlocked: 'secret' }), 'kube.toolbar.reloadSecret')
    expect(secret).toContain('disabled')
    expect(secret).toContain('title="kube.toolbar.reloadSecret"')
    const multi = render({ reloadBlocked: 'multi' })
    expect(multi).toContain('title="kube.toolbar.reloadMulti"')
  })
})

describe('Kustomize member', () => {
  const k = {
    kind: 'manifest',
    overlays: ['/p/envs/dev'],
    overlay: '/p/envs/dev'
  }

  it('hides reload, shows the eye with aria-pressed, the overlay pill and the info strip with the command', () => {
    const html = render(k)
    expect(html).not.toContain('aria-label="kube.toolbar.reload"')
    const eye = button(html, 'kube.toolbar.renderedView')
    expect(eye).toContain('aria-pressed="false"')
    expect(button(render({ ...k, renderOpen: true }), 'kube.toolbar.renderedView')).toContain('aria-pressed="true"')
    expect(html).toContain('envs/dev')
    expect(html).toContain('kube.toolbar.kustomizeNote')
    expect(html).toContain('kubectl apply -k /p/envs/dev')
  })

  it('a kustomization.yaml itself is Kustomize too', () => {
    const html = render({ kind: 'kustomization', overlays: ['/p/envs/dev'], overlay: '/p/envs/dev' })
    expect(html).toContain('kube.toolbar.renderedView')
  })

  it('with several overlays and no pick the overlay pill asks and the actions stay disabled', () => {
    const html = render({
      ...k,
      overlays: ['/p/envs/dev', '/p/envs/prod'],
      overlay: null,
      target: { state: 'none' }
    })
    expect(html).toContain('kube.toolbar.chooseOverlay')
    expect(html).toContain('<option')
    expect(button(html, 'kube.toolbar.apply')).toContain('disabled')
    expect(html).not.toContain('kubectl apply -k')
  })

  it('a locked namespace is a non-interactive pill with a lock and the kustomization tooltip', () => {
    const html = render({ ...k, nsLocked: 'shop-prod', pill: 'shop-prod' })
    expect(html).toContain('kube.toolbar.ns{&quot;ns&quot;:&quot;shop-prod&quot;}')
    expect(html).toContain('title="kube.toolbar.nsLocked"')
    expect(html).toContain('kube-pill-locked')
    expect(html).not.toMatch(/<button[^>]*kube-pill-ns/)
  })
})

describe('namespace pill', () => {
  it('is a button that opens the namespace picker', () => {
    expect(render()).toMatch(/<button[^>]*kube-pill-ns/)
  })

  it('reads "from the file" when every resource names its namespace', () => {
    const html = render({ nsFromFile: true, pill: null })
    expect(html).toContain('kube.toolbar.nsFromFile')
    expect(html).not.toContain('kube.toolbar.ns{')
  })
})

describe('notices', () => {
  it('a Helm template shows only the notice, no actions', () => {
    const html = render({ kind: 'helm-template' })
    expect(html).toContain('kube.toolbar.helm')
    expect(html).not.toContain('kube.toolbar.apply')
    expect(html).not.toContain('kind-dev')
  })

  it('a kustomization over the file that does not parse disables every action and says to fix it first', () => {
    const html = render({ brokenKustomization: '/p/apps/app' })
    for (const k of ['compare', 'apply', 'reload', 'delete']) expect(button(html, `kube.toolbar.${k}`)).toContain('disabled')
    expect(html).toContain('kube.toolbar.brokenKustomization')
    expect(html).toContain('/p/apps/app')
    const kustomize = render({ kind: 'kustomization', overlays: ['/p/apps/app'], overlay: '/p/apps/app', brokenKustomization: '/p/apps/app' })
    for (const k of ['compare', 'apply', 'delete']) expect(button(kustomize, `kube.toolbar.${k}`)).toContain('disabled')
    expect(kustomize).toContain('kube.toolbar.brokenKustomization')
    expect(render()).not.toContain('kube.toolbar.brokenKustomization')
  })

  it('a manifest no kustomization beside it lists disables every action, the chip too, and says why', () => {
    const html = render({ unlisted: true, status: { kind: 'different', lines: 2 } })
    for (const k of ['compare', 'apply', 'reload', 'delete']) expect(button(html, `kube.toolbar.${k}`)).toContain('disabled')
    expect(html).toMatch(/<button[^>]*class="kube-chip kube-chip-btn"[^>]*disabled/)
    expect(html).toContain('kube.toolbar.unlisted')
    expect(render()).not.toContain('kube.toolbar.unlisted')
  })

  it('a missing kubectl shows the notice with a settings button', () => {
    const html = render({ kubectlMissing: true })
    expect(html).toContain('kube.toolbar.kubectlMissing')
    expect(html).toMatch(/<button[^>]*kube-link[^>]*>kube\.toolbar\.openSettings/)
    expect(html).not.toContain('kube.toolbar.apply')
  })
})

describe('status chip', () => {
  const chip = (status: unknown, extra: Record<string, unknown> = {}): string => render({ status, ...extra })

  it('same, different (lines and resources), absent, unknown with its reason', () => {
    expect(chip({ kind: 'same' })).toContain('kube.chip.same')
    expect(chip({ kind: 'different', lines: 4 })).toContain('kube.chip.differentLines{&quot;lines&quot;:4}')
    expect(chip({ kind: 'different', resources: 2 })).toContain('kube.chip.differentResources{&quot;resources&quot;:2}')
    expect(chip({ kind: 'absent' })).toContain('kube.chip.absent')
    const u = chip({ kind: 'unknown', reason: 'no-target' })
    expect(u).toContain('kube.chip.unknown')
    expect(u).toContain('title="no-target"')
  })

  it('different and not in cluster are buttons that open the comparison; same and unknown are not', () => {
    for (const status of [{ kind: 'different', lines: 4 }, { kind: 'absent' }]) {
      const html = chip(status)
      expect(html).toMatch(/<button[^>]*class="kube-chip kube-chip-btn"/)
      const b = /<button[^>]*class="kube-chip kube-chip-btn"[^>]*>/.exec(html)?.[0] ?? ''
      expect(b).toMatch(/title="kube\.chip\.openCompare[^"]*"/)
      expect(b.match(/title="([^"]*)"/)?.[1]).toBe(b.match(/aria-label="([^"]*)"/)?.[1])
      expect(b).not.toContain('disabled')
      // waits like the compare button does
      expect(chip(status, { busy: true })).toMatch(/<button[^>]*class="kube-chip kube-chip-btn"[^>]*disabled/)
    }
    expect(chip({ kind: 'same' })).not.toContain('kube-chip-btn')
    expect(chip({ kind: 'unknown', reason: 'x' })).not.toContain('kube-chip-btn')

    const onCompare = vi.fn()
    const el = StatusChip({ status: { kind: 'different', lines: 2 }, loading: false, onCompare, disabled: false }) as React.ReactElement<{
      onClick: () => void
    }>
    el.props.onClick()
    expect(onCompare).toHaveBeenCalledTimes(1)
  })

  it('a loading status shows a spinner instead', () => {
    const html = chip(null, { statusLoading: true })
    expect(html).toContain('loading-spinner')
    expect(html).toContain('kube.chip.loading')
  })

  it('shows the kind and name of the resource', () => {
    expect(render({ resourceLabel: 'Deployment · web' })).toContain('Deployment · web')
  })
})

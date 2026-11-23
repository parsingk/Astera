import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ObjectRef } from '../../../../../core/kube/cluster/types'
import type { K8sObject } from '../../../../../core/kube/objects'
import { KubeForwardDialog, remotePortItems } from './KubeForwardDialog'

vi.mock('../../../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'en',
    t: (key: string, p?: Record<string, unknown>) => (p ? `${key}${JSON.stringify(p)}` : key),
    tm: (m: unknown) => String(m)
  })
}))

const target: ObjectRef = { context: 'prod', namespace: 'shop', resource: 'services', kind: 'Service', name: 'web' }
const service = (ports: unknown[]): K8sObject =>
  ({ kind: 'Service', metadata: { name: 'web', namespace: 'shop' }, spec: { ports } }) as unknown as K8sObject

const render = (object: K8sObject): string =>
  renderToStaticMarkup(
    React.createElement(KubeForwardDialog, { target, object, onStart: () => {}, onCancel: () => {} })
  )

describe('KubeForwardDialog', () => {
  it('shows the target and its ports', () => {
    const html = render(service([{ port: 80, name: 'http' }, { port: 443 }]))
    expect(html).toContain('kube.forward.title')
    expect(html).toContain('Service')
    expect(html).toContain('web')
    expect(html).toContain('prod')
    expect(html).toContain('shop')
    // The remote port is the app's Select: closed, its trigger shows the first port.
    expect(html).toContain('>80 http<')
    expect(html).not.toContain('<select')
    expect(html).toMatch(/<button[^>]*class="sel-trigger"[^>]*aria-label="kube.forward.remote"/)
  })

  it('draws the target kind as the list chip', () => {
    expect(render(service([{ port: 80 }]))).toContain('<span class="kube-forward-kind">Service</span>')
  })

  it('starts on Other port for a target with no ports', () => {
    const html = render(service([]))
    expect(html).not.toContain('<select')
    expect(html).toContain('inputMode="numeric"')
  })

  it('disables Start until both ports are valid', () => {
    const html = render(service([{ port: 80, name: 'http' }]))
    // the local field starts empty until localPort answers
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>kube\.forward\.start</)
  })

  it('names its fields', () => {
    const html = render(service([{ port: 80, name: 'http' }]))
    const forOf = [...html.matchAll(/<label[^>]*for="([^"]+)"/g)].map((m) => m[1])
    const inputs = [...html.matchAll(/<input[^>]*id="([^"]+)"/g)].map((m) => m[1])
    // With ports the remote field is the Select, named through its aria-label; no label may point at nothing.
    expect(html).toMatch(/aria-label="kube.forward.remote"/)
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])
    for (const f of forOf) expect(ids).toContain(f)
    expect(inputs.length).toBeGreaterThan(0)
    for (const id of inputs) expect(forOf).toContain(id)
    expect(html).not.toContain('type="number"')
    expect(html).toContain('inputMode="numeric"')
  })

  it('is a named modal dialog', () => {
    const html = render(service([]))
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    const labelled = /aria-labelledby="([^"]+)"/.exec(html)?.[1]
    expect(labelled).toBeTruthy()
    expect(html).toContain(`id="${labelled}"`)
  })
})

describe('remotePortItems', () => {
  it('lists each port with its name, then the Other port item last', () => {
    expect(remotePortItems([{ port: 80, name: 'http' }, { port: 443 }], 'Other port')).toEqual([
      { value: '80', label: '80 http' },
      { value: '443', label: '443' },
      { value: 'other', label: 'Other port' }
    ])
  })
})

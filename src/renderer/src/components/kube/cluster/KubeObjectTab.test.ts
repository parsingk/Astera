import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { KubeObjectTab, followTabObject, applyEdit, type KubeTabHost } from './KubeObjectTab'
import { liveErrorText } from './ClusterView'
import { KUBECTL_MISSING, LIST_PAGE_TOO_LARGE } from '../../../../../core/kube/cluster/types'

vi.mock('../../../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    t: (key: string, p?: Record<string, unknown>) => (p ? `${key}${JSON.stringify(p)}` : key),
    tm: (m: unknown) => String(m)
  })
}))

const pod = { context: 'arn:aws:eks:ap-northeast-2:1:cluster/live', namespace: 'api', resource: 'pods', kind: 'Pod', name: 'w-1' }
const stubHost = (): KubeTabHost & { writes: unknown[] } => {
  const writes: unknown[] = []
  return { writes, startWrite: (op) => void writes.push(op), setDirty: () => undefined, editAsks: {} }
}
const render = (target: typeof pod | { context: string; namespace: null; resource: string; kind: string; name: string }): string =>
  renderToStaticMarkup(React.createElement(KubeObjectTab, { target, visible: true, tabId: 'kube:t', host: stubHost() }))


/** A tag's attributes, to follow the ids that tie a tab to its panel. */
const attrs = (tag: string): Record<string, string> => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]))
const tabsIn = (html: string): Array<Record<string, string>> => [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((m) => attrs(m[0]))
const panelIn = (html: string): Record<string, string> => attrs(html.match(/<div[^>]*role="tabpanel"[^>]*>/)?.[0] ?? '')

// Spec 4.6 and board B: where the object lives, a read-only chip, and the views; P1 has no edit, apply or compare.
describe('KubeObjectTab', () => {
  it('draws where the object lives, the read-only chip and the view switch', () => {
    const html = render(pod)
    expect(html).toContain('live / api')
    expect(html).toContain('kube.cluster.readOnly')
    for (const v of ['yaml', 'describe', 'events']) expect(html).toContain(`kube.cluster.tab.${v}`)
    expect(html).toContain('kube.cluster.loading') // nothing read yet
  })

  // Task 12 minor, as in the detail: the view switch's tabs control the tab's body, with one tab stop.
  it('ties the shown view to the body, with one tab stop', () => {
    const html = render(pod)
    const tabs = tabsIn(html)
    const panel = panelIn(html)
    expect(tabs.map((tb) => tb['aria-selected'])).toEqual(['true', 'false', 'false'])
    expect(tabs[0]['aria-controls']).toBe(panel.id)
    expect(panel['aria-labelledby']).toBe(tabs[0].id)
    expect(tabs.map((tb) => tb.tabindex)).toEqual(['0', '-1', '-1'])
  })

  it('names only the context for a cluster-scoped object', () => {
    const html = render({ context: 'kind-dev', namespace: null, resource: 'nodes', kind: 'Node', name: 'n1' })
    expect(html).toContain('>kind-dev<')
    expect(html).not.toContain('kind-dev / ')
  })

  it('says kubectl is missing in the catalog words', () => {
    expect(liveErrorText(KUBECTL_MISSING, (k) => `t:${k}`)).toBe('t:kube.cluster.kubectlMissing')
    expect(liveErrorText('Unable to connect to the server', (k) => `t:${k}`)).toBe('Unable to connect to the server')
  })

  // Final review M3: the app's own words for a list page over the cap, not kubectl's, so they are translated too.
  it('says a list page was too large in the catalog words', () => {
    expect(liveErrorText(LIST_PAGE_TOO_LARGE, (k) => `t:${k}`)).toBe('t:kube.cluster.pageTooLarge')
  })

  // Task 14 minor: this rendered only the loading state. Loaded (the YAML drawn), the tab still offers only reads: refresh,
  // and a Secret's show values; edit, apply and compare come with P3.
  it('offers no control that would change the object, once it is loaded', () => {
    const object = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'w-1', namespace: 'api', uid: 'u1', resourceVersion: '7' }, spec: { containers: [{ name: 'app', image: 'x:1' }] } }
    const html = renderToStaticMarkup(React.createElement(KubeObjectTab, { target: pod, visible: true, initial: object, tabId: 'kube:p', host: stubHost() }))
    expect(html).not.toContain('kube.cluster.loading')
    expect(html).toContain('name: w-1')
    expect([...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1])).toEqual(['kube.edit.start', 'kube.cluster.refresh'])
    expect(html).not.toMatch(/contenteditable|<textarea|kube\.toolbar\.(apply|compare|edit)|kube\.cluster\.(edit|apply|compare)/)

    const secret = { apiVersion: 'v1', kind: 'Secret', metadata: { name: 's', namespace: 'api', uid: 'u2', resourceVersion: '3' }, data: { p: '***' } }
    const target = { ...pod, resource: 'secrets', kind: 'Secret', name: 's' }
    const shown = renderToStaticMarkup(React.createElement(KubeObjectTab, { target, visible: true, initial: secret, tabId: 'kube:s', host: stubHost() }))
    expect([...shown.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1])).toEqual(['kube.edit.start', 'kube.cluster.refresh', 'kube.cluster.showValues'])
  })
})

describe('KubeObjectTab edit mode', () => {
  const object = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'w-1', namespace: 'api', uid: 'u1', resourceVersion: '7' }, spec: {} }
  const secret = { apiVersion: 'v1', kind: 'Secret', metadata: { name: 's', namespace: 'api', uid: 'u2', resourceVersion: '3' }, data: { p: '***' } }
  const secretTarget = { ...pod, resource: 'secrets', kind: 'Secret', name: 's' }
  const labels = (html: string): string[] => [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1])

  it('offers Edit for a Secret only while its values are shown', () => {
    const host = stubHost()
    const html = renderToStaticMarkup(React.createElement(KubeObjectTab, { target: secretTarget, visible: true, initial: secret, tabId: 'kube:s', host }))
    expect(html).toMatch(/<button[^>]*aria-label="kube\.edit\.start"[^>]*disabled/)
    expect(html).toContain('title="kube.edit.revealFirst"')
    const plain = renderToStaticMarkup(React.createElement(KubeObjectTab, { target: pod, visible: true, initial: object, tabId: 'kube:p', host }))
    expect(plain).not.toMatch(/<button[^>]*aria-label="kube\.edit\.start"[^>]*disabled/)
    expect(labels(plain)).toContain('kube.edit.start')
  })

  it('shows the edit buttons and the editing chip in edit mode', () => {
    const initialEdit = { text: 'kind: Pod', base: { resourceVersion: '7', hash: 'h' } }
    const html = renderToStaticMarkup(
      React.createElement(KubeObjectTab, { target: pod, visible: true, initial: object, tabId: 'kube:p', host: stubHost(), initialEdit })
    )
    expect(html).toContain('kube.edit.editing')
    expect(html).not.toContain('kube.cluster.readOnly')
    expect(html).toContain('kind: Pod')
    expect(labels(html)).toContain('kube.edit.apply')
    expect(labels(html)).toContain('kube.edit.discard')
    expect(labels(html)).not.toContain('kube.edit.start')
    expect(html).not.toContain('kube.cluster.serverFields')
  })

  it('starts the replace dialog with the edit text and base', () => {
    const host = stubHost()
    const base = { resourceVersion: '7', hash: 'h' }
    const done = (): void => undefined
    applyEdit(host, pod, { text: 'a: 1', base }, done)
    expect(host.writes).toEqual([{ verb: 'replace', ref: pod, text: 'a: 1', base }])
  })
})

// Task 14 minor: the tab's watch lifecycle was verified by reading only. Driven here by a fake watch client and read, as
// kubeWatchClient.test.ts drives its api: stopped on hide and unmount, a late read ignored, a resync read again, paused
// at the limit.
describe('followTabObject', () => {
  type Answer = Awaited<ReturnType<typeof window.api.kube.cluster.get>>
  const obj = (rv: string) => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'w-1', namespace: 'api', uid: 'u1', resourceVersion: rv } })
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  function setup(answer: { ok: true } | { ok: false; reason: 'limit' } = { ok: true }) {
    let deliver: ((m: unknown) => void) | null = null
    const specs: unknown[] = []
    let stopped = 0
    const client = {
      subscribe: async (spec: unknown, cb: (m: unknown) => void) => {
        specs.push(spec)
        deliver = cb
        return answer.ok ? { ok: true as const, stop: () => void stopped++ } : answer
      }
    }
    const reads: Array<(a: Answer) => void> = []
    const got: Array<{ object: unknown } | { fail: string | null } | { state: unknown }> = []
    const stop = followTabObject({
      client: client as never,
      get: () => new Promise<Answer>((r) => void reads.push(r)),
      target: pod,
      take: (object) => void got.push({ object: object?.metadata.resourceVersion ?? null }),
      fail: (message) => void got.push({ fail: message }),
      state: (s) => void got.push({ state: s })
    })
    const send = (m: object): void => deliver!({ watchId: 'w', ...m })
    return { stop, reads, got, specs, send, stopped: () => stopped }
  }

  it('reads the object, follows its watch by name, and drops a read that answers after the watch spoke', async () => {
    const t = setup()
    await settle()
    expect(t.specs).toEqual([{ context: pod.context, namespace: 'api', namespaced: true, resource: 'pods', name: 'w-1' }])
    t.send({ kind: 'event', event: { type: 'MODIFIED', object: obj('8') } })
    t.reads[0]({ ok: true, object: obj('7') })
    await settle()
    expect(t.got).toEqual([{ state: 'live' }, { fail: null }, { object: '8' }])
    t.send({ kind: 'event', event: { type: 'DELETED', object: obj('9') } })
    expect(t.got.at(-1)).toEqual({ object: null })
    t.stop()
  })

  it('reads again on a resync, and that read applies', async () => {
    const t = setup()
    await settle()
    t.send({ kind: 'event', event: { type: 'ADDED', object: obj('7') } })
    t.send({ kind: 'resync' })
    expect(t.reads).toHaveLength(2)
    t.reads[1]({ ok: true, object: obj('10') })
    await settle()
    expect(t.got.at(-1)).toEqual({ object: '10' })
    t.stop()
  })

  it('shows a failed read until the watch brings the object', async () => {
    const t = setup()
    await settle()
    t.reads[0]({ ok: false, message: 'Error from server (Forbidden): pods "w-1" is forbidden' })
    await settle()
    expect(t.got.at(-1)).toEqual({ fail: 'Error from server (Forbidden): pods "w-1" is forbidden' })
    t.send({ kind: 'event', event: { type: 'ADDED', object: obj('7') } })
    expect(t.got.slice(-2)).toEqual([{ fail: null }, { object: '7' }])
    t.stop()
  })

  it('stops its watch on hide or unmount, and applies nothing after', async () => {
    const t = setup()
    await settle()
    t.stop()
    expect(t.stopped()).toBe(1)
    const before = t.got.length
    t.reads[0]({ ok: true, object: obj('7') })
    t.send({ kind: 'event', event: { type: 'MODIFIED', object: obj('8') } })
    await settle()
    expect(t.got).toHaveLength(before)
  })

  it('is paused at the watch limit, where the read is all there is', async () => {
    const t = setup({ ok: false, reason: 'limit' })
    await settle()
    t.reads[0]({ ok: true, object: obj('7') })
    await settle()
    expect(t.got).toEqual([{ state: 'live' }, { state: 'limit' }, { fail: null }, { object: '7' }])
    t.stop()
    expect(t.stopped()).toBe(0)
  })
})

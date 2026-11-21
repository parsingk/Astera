import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { KubeObjectTab, askCompare, compareAskKey, followTabObject, applyEdit, applyCurrentEdit, editAskOutcome, watchChip, type KubeTabHost } from './KubeObjectTab'
import { liveErrorText } from './ClusterView'
import type { ManifestMatch } from '../../../../../core/kube/cluster/types'
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
  return { writes, startWrite: (op) => void writes.push(op), setDirty: () => undefined, editAsks: {}, compareTarget: async () => ({ state: 'none' }), startCompare: () => undefined, compareKey: '/p' }
}
const render = (target: typeof pod | { context: string; namespace: null; resource: string; kind: string; name: string }): string =>
  renderToStaticMarkup(React.createElement(KubeObjectTab, { target, visible: true, tabId: 'kube:t', host: stubHost() }))


/** A tag's attributes, to follow the ids that tie a tab to its panel. */
const attrs = (tag: string): Record<string, string> => Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]))
const tabsIn = (html: string): Array<Record<string, string>> => [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((m) => attrs(m[0]))
const panelIn = (html: string): Record<string, string> => attrs(html.match(/<div[^>]*role="tabpanel"[^>]*>/)?.[0] ?? '')

// Spec 4.6 and board B: where the object lives, a read-only chip, and the views; compare comes later.
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

  // Task 14 minor: this rendered only the loading state. Loaded (the YAML drawn), the tab offers Edit and the reads: refresh,
  // and a Secret's show values; apply and discard appear only in edit mode, and compare comes later.
  it('offers only Edit and the reads, with no apply or compare, once it is loaded', () => {
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
    // Nothing is watched while editing, so the chip must not say live.
    expect(html).toContain('kube.cluster.paused')
    expect(html).not.toContain('kube.cluster.live')
    // The views stay, tied to the body; the YAML view shows the editor.
    const tabs = tabsIn(html)
    expect(tabs).toHaveLength(3)
    expect(panelIn(html)['aria-labelledby']).toBe(tabs[0].id)
  })

  it('says why Edit is off for an object that is not loaded or is deleted, not to show values', () => {
    const html = renderToStaticMarkup(React.createElement(KubeObjectTab, { target: secretTarget, visible: true, tabId: 'kube:s', host: stubHost() }))
    expect(html).toContain('title="kube.edit.start"')
    expect(html).not.toContain('kube.edit.revealFirst')
  })

  it('draws the live chip as paused while editing, whatever the watch said', () => {
    expect(watchChip('live', true, false)).toBe('live')
    expect(watchChip('live', true, true)).toBe('paused')
    expect(watchChip('live', false, false)).toBe('paused')
    expect(watchChip({ error: 'x' }, true, true)).toBe('paused')
    expect(watchChip({ error: 'x' }, true, false)).toEqual({ error: 'x' })
  })

  it('starts editing for any kind, but keeps a Secret that is not shown read-only with the note', () => {
    expect(editAskOutcome('Pod', false, false)).toBe('start')
    expect(editAskOutcome('Secret', true, false)).toBe('start')
    expect(editAskOutcome('Secret', false, false)).toBe('revealFirst')
    expect(editAskOutcome('Secret', true, true)).toBe('ignore')
    expect(editAskOutcome('Pod', false, true)).toBe('ignore')
  })

  it('hands Apply the editor text, not the start text', () => {
    const host = stubHost()
    const base = { resourceVersion: '7', hash: 'h' }
    applyCurrentEdit(host, pod, { text: 'a: 1', base }, 'a: 2', () => undefined)
    expect(host.writes).toEqual([{ verb: 'replace', ref: pod, text: 'a: 2', base }])
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

describe('KubeObjectTab compare', () => {
  const object = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'w-1', namespace: 'api', uid: 'u1', resourceVersion: '7' }, spec: {} }
  const html = (initialMatch: ManifestMatch, extra: { initialEdit?: { text: string; base: { resourceVersion: string; hash: string } } } = {}): string =>
    renderToStaticMarkup(React.createElement(KubeObjectTab, { target: pod, visible: true, initial: object, tabId: 'kube:p', host: stubHost(), initialMatch, ...extra }))
  const labels = (h: string): string[] => [...h.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1])

  it('shows compare for the same target and a tooltip for another', () => {
    expect(labels(html({ state: 'none' }))).not.toContain('kube.edit.compare')
    const same = html({ state: 'same', file: '/p/k8s/a.yaml' })
    expect(same).toMatch(/<button[^>]*aria-label="kube\.edit\.compare"/)
    expect(same).toContain('title="kube.edit.compare"')
    // Compare reads the file against the cluster, so edit mode keeps it.
    const edit = { text: 'kind: Pod', base: { resourceVersion: '7', hash: 'h' } }
    expect(labels(html({ state: 'same', file: '/p/k8s/a.yaml' }, { initialEdit: edit }))).toContain('kube.edit.compare')
    const other = html({ state: 'other', file: 'k8s/a.yaml', context: 'kind-dev', namespace: 'dev' })
    expect(other).not.toMatch(/<button[^>]*aria-label="kube\.edit\.compare"/)
    expect(other).toContain('kube.edit.compareElsewhere')
    expect(other).toContain('k8s/a.yaml')
    expect(other).toContain('kind-dev / dev')
    const arn = 'arn:aws:eks:eu-west-1:2:cluster/other'
    expect(html({ state: 'other', file: 'a.yaml', context: arn, namespace: null })).toContain(`&quot;target&quot;:&quot;${arn}`)
  })

  it('asks again when the object, the target or the project changes', () => {
    expect(compareAskKey('u1', 'k', '/p')).not.toBe(compareAskKey('u2', 'k', '/p'))
    expect(compareAskKey('u1', 'k', '/p')).not.toBe(compareAskKey('u1', 'k2', '/p'))
    expect(compareAskKey('u1', 'k', '/p')).not.toBe(compareAskKey('u1', 'k', '/q'))
  })

  it('asks the host again when the object changes and drops an answer that came late', async () => {
    const answers: Array<(m: ManifestMatch) => void> = []
    const ask = (): Promise<ManifestMatch> => new Promise((r) => void answers.push(r))
    const seen: ManifestMatch[] = []
    const stop = askCompare({ ask, apply: (m) => seen.push(m) })
    // A new ask clears the icon of the last answer at once.
    expect(seen).toEqual([{ state: 'none' }])
    seen.length = 0
    answers[0]({ state: 'same', file: 'a' })
    await Promise.resolve()
    await Promise.resolve()
    expect(seen).toEqual([{ state: 'same', file: 'a' }])
    const stop2 = askCompare({ ask: () => Promise.reject(new Error('x')), apply: (m) => seen.push(m) })
    await Promise.resolve()
    await Promise.resolve()
    expect(seen.at(-1)).toEqual({ state: 'none' })
    const late: Array<(m: ManifestMatch) => void> = []
    const stop3 = askCompare({ ask: () => new Promise((r) => void late.push(r)), apply: (m) => seen.push(m) })
    stop3()
    late[0]({ state: 'same', file: 'late' })
    await Promise.resolve()
    expect(seen).not.toContainEqual({ state: 'same', file: 'late' })
    stop()
    stop2()
  })
})

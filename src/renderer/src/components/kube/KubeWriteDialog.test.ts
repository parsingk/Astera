import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Dependents, LiveOp, LivePreview, Read } from '../../../../core/kube/cluster/types'
import { KubeWriteDialog, writeConfirmable } from './KubeWriteDialog'

vi.mock('../../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    t: (key: string, p?: Record<string, unknown>) => (p ? `${key}${JSON.stringify(p)}` : key),
    tm: (m: unknown) => String(m)
  })
}))

const ref = (over: Partial<LiveOp['ref']> = {}): LiveOp['ref'] => ({
  context: 'prod',
  namespace: 'shop',
  resource: 'deployments',
  kind: 'Deployment',
  name: 'web',
  ...over
})

const okPreview = (over: Record<string, unknown> = {}): LivePreview => ({
  ok: true,
  commandLines: [['rollout', 'restart', 'deployment/web', '--context', 'prod', '-n', 'shop']],
  checkCommandLines: [],
  diff: {
    ref: 'Deployment/shop/web',
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
    changedLines: 2
  },
  fingerprint: 'fp',
  ...over
})

const none: Dependents = { goes: [], kept: [], affected: [], incomplete: false, recreatedBy: null }
const deps = (d: Partial<Dependents> = {}): Read<{ dependents: Dependents }> => ({
  ok: true,
  dependents: { ...none, ...d }
})

const opOf = {
  replace: (kind = 'Deployment'): LiveOp => ({
    verb: 'replace',
    ref: ref({ kind }),
    text: 'x',
    base: { resourceVersion: '1', hash: 'h' }
  }),
  delete: (kind = 'Deployment', name = 'web'): LiveOp => ({ verb: 'delete', ref: ref({ kind, name }) }),
  restart: (): LiveOp => ({ verb: 'restart', ref: ref() }),
  scale: (): LiveOp => ({ verb: 'scale', ref: ref(), replicas: 3 })
}

const base = (op: LiveOp, preview: LivePreview | null, over: Record<string, unknown> = {}) => ({
  op,
  preview,
  dependents: op.verb === 'delete' ? deps() : null,
  keepServerFields: false,
  onToggleServerFields: () => {},
  showValues: false,
  onToggleValues: () => {},
  replicas: '3',
  onReplicas: () => {},
  typed: '',
  onTyped: () => {},
  stale: false,
  running: false,
  cancelling: false,
  onConfirm: () => {},
  onCancel: () => {},
  onAbort: () => {},
  ...over
})

const render = (op: LiveOp, preview: LivePreview | null, over: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(React.createElement(KubeWriteDialog, base(op, preview, over) as never)).replaceAll('&quot;', '"')

describe('KubeWriteDialog', () => {
  it('names the context on the one button for each verb', () => {
    expect(render(opOf.replace(), okPreview())).toContain('kube.confirm.apply{"context":"prod"}')
    expect(render(opOf.delete(), okPreview())).toContain('kube.confirm.delete{"context":"prod"}')
    expect(render(opOf.restart(), okPreview())).toContain('kube.write.restartIn{"context":"prod"}')
    expect(render(opOf.scale(), okPreview())).toContain('kube.write.scaleIn{"context":"prod"}')
    expect(render(opOf.delete(), okPreview())).toContain('primary danger')
    expect(render(opOf.delete(), okPreview())).toContain('kube.write.title.delete')
    expect(render(opOf.restart(), okPreview())).toContain('Deployment/shop/web')
  })

  it('lists what goes with a delete, what is kept and the owner that recreates it', () => {
    const html = render(opOf.delete('StatefulSet'), okPreview(), {
      dependents: deps({
        goes: [{ kind: 'Pod', count: 3, names: ['shop/db-0', 'shop/db-1'] }],
        kept: [{ kind: 'PersistentVolumeClaim', count: 2, names: ['shop/data-0', 'shop/data-1'] }],
        recreatedBy: { kind: 'Deployment', name: 'web' }
      })
    })
    expect(html).toContain('kube.write.goes')
    expect(html).toContain('Pod')
    expect(html).toContain('shop/db-0')
    expect(html).toContain('…')
    expect(html).toContain('kube.write.kept')
    expect(html).toContain('shop/data-1')
    expect(html).toContain('kube.write.recreatedBy{"kind":"Deployment","name":"web"}')
    expect(html).not.toContain('kube.write.nothingElse')
  })

  it('says nothing else goes when all are empty, and uses the node and claim wording', () => {
    expect(render(opOf.delete(), okPreview())).toContain('kube.write.nothingElse')
    const node = render(opOf.delete('Node'), okPreview(), {
      dependents: deps({ affected: [{ kind: 'Pod', count: 1, names: ['shop/a'] }] })
    })
    expect(node).toContain('kube.write.nodePods')
    const pv = render(opOf.delete('PersistentVolume'), okPreview(), {
      dependents: deps({ affected: [{ kind: 'PersistentVolumeClaim', count: 1, names: ['shop/c'] }] })
    })
    expect(pv).toContain('kube.write.boundClaim')
  })

  it('says a namespace list may be incomplete', () => {
    expect(render(opOf.delete('Namespace', 'api'), okPreview(), { dependents: deps({ incomplete: true }) })).toContain(
      'kube.write.incomplete'
    )
    expect(render(opOf.delete(), okPreview())).not.toContain('kube.write.incomplete')
  })

  it('shows why the dependents could not be read', () => {
    const html = render(opOf.delete(), okPreview(), { dependents: { ok: false, message: 'no access' } })
    expect(html).toContain('kube.write.dependentsFailed{"detail":"no access"}')
  })

  it('enables a Namespace delete only after its name is typed', () => {
    const op = opOf.delete('Namespace', 'api')
    const args = (typed: string) => ({ op, preview: okPreview(), dependents: deps(), typed, stale: false, running: false })
    expect(writeConfirmable(args('ap'))).toBe(false)
    expect(writeConfirmable(args('api'))).toBe(true)
    const off = render(op, okPreview(), { typed: 'ap' })
    expect(off).toContain('kube.write.typeName{"name":"api"}')
    expect(off).toMatch(/<button[^>]*primary danger[^>]*disabled/)
    expect(render(op, okPreview(), { typed: 'api' })).not.toMatch(/<button[^>]*primary danger[^>]*disabled/)
    expect(render(opOf.delete(), okPreview())).not.toContain('kube.write.typeName')
  })

  it('waits for the dependents before a delete can be confirmed', () => {
    const op = opOf.delete()
    const args = (dependents: Read<{ dependents: Dependents }> | null) => ({
      op,
      preview: okPreview(),
      dependents,
      typed: '',
      stale: false,
      running: false
    })
    expect(writeConfirmable(args(null))).toBe(false)
    expect(writeConfirmable(args(deps()))).toBe(true)
    expect(writeConfirmable(args({ ok: false, message: 'x' }))).toBe(true)
    expect(writeConfirmable({ ...args(deps()), stale: true })).toBe(false)
    expect(writeConfirmable({ ...args(deps()), running: true })).toBe(false)
    expect(writeConfirmable({ ...args(deps()), preview: null })).toBe(false)
    expect(writeConfirmable({ ...args(deps()), preview: { ok: false, reason: 'gone' } })).toBe(false)
  })

  it('shows the changed banner for an edit', () => {
    expect(render(opOf.replace(), okPreview({ changedSinceEdit: true }))).toContain('kube.write.changedSinceEdit')
    expect(render(opOf.replace(), okPreview())).not.toContain('kube.write.changedSinceEdit')
  })

  it('offers show values for a Secret edit only', () => {
    expect(render(opOf.replace('Secret'), okPreview())).toContain('kube.cluster.showValues')
    expect(render(opOf.replace('Secret'), okPreview(), { showValues: true })).toContain('kube.cluster.hideValues')
    expect(render(opOf.replace(), okPreview())).not.toContain('kube.cluster.showValues')
    expect(render(opOf.delete('Secret'), okPreview())).not.toContain('kube.cluster.showValues')
  })

  it('shows each refusal', () => {
    const r = (preview: LivePreview, op: LiveOp = opOf.replace()): string => render(op, preview)
    expect(r({ ok: false, reason: 'gone' })).toContain('kube.write.gone')
    expect(r({ ok: false, reason: 'paused' }, opOf.restart())).toContain('kube.write.paused')
    expect(r({ ok: false, reason: 'kind' }, opOf.scale())).toContain('kube.write.kind{"kind":"Deployment"}')
    expect(r({ ok: false, reason: 'edit', problem: 'yaml', detail: 'line 3' })).toContain(
      'kube.write.edit.yaml{"detail":"line 3"}'
    )
    expect(r({ ok: false, reason: 'edit', problem: 'not-one', detail: '' })).toContain('kube.write.edit.notOne')
    expect(r({ ok: false, reason: 'edit', problem: 'identity', detail: '' })).toContain('kube.write.edit.identity')
    expect(r({ ok: false, reason: 'edit', problem: 'base64', detail: 'key' })).toContain(
      'kube.write.edit.base64{"detail":"key"}'
    )
    const k = r({
      ok: false,
      reason: 'kubectl',
      commandLines: [['replace']],
      checkCommandLines: [],
      stderr: 'boom <err>',
      timedOut: true
    })
    expect(k).toContain('boom &lt;err&gt;')
    expect(k).toContain('kube.confirm.timedOut')
  })

  it('shows the replicas field for scale only', () => {
    const scale = render(opOf.scale(), okPreview(), { replicas: '5' })
    expect(scale).toContain('kube.write.replicas')
    expect(scale).toContain('value="5"')
    expect(render(opOf.restart(), okPreview())).not.toContain('kube.write.replicas')
  })

  it('lists the commands to run', () => {
    const html = render(opOf.restart(), okPreview())
    expect(html).toContain('kube.confirm.commandsToRun')
    expect(html).toContain('kubectl rollout restart deployment/web')
    expect(html).toContain('kube.confirm.copyCommands')
  })

  it('stays up with a stop button while running', () => {
    const html = render(opOf.restart(), okPreview(), { running: true })
    expect(html).toContain('kube.confirm.abort')
    expect(html).toMatch(/<button[^>]*primary[^>]*disabled[^>]*>(<span[^>]*><\/span>)?kube.write.restartIn/)
  })
})

describe('KubeWriteDialog scale hint', () => {
  it('hints at the field instead of loading while the count is not a valid integer', () => {
    for (const replicas of ['', '-1', '1.5', '2147483648']) {
      const html = render(opOf.scale(), null, { replicas })
      expect(html).toContain('kube.write.replicasHint')
      expect(html).not.toContain('kube.write.loading')
    }
    const loading = render(opOf.scale(), null, { replicas: '3' })
    expect(loading).toContain('kube.write.loading')
    expect(loading).not.toContain('kube.write.replicasHint')
    expect(render(opOf.restart(), null)).not.toContain('kube.write.replicasHint')
  })
})

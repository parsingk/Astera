import { describe, it, expect } from 'vitest'
import { clusterMenuItems, shellChoice, writeMenuHandlers } from './clusterMenu'
import type { K8sObject } from '../../../../../core/kube/objects'

const label = (i: unknown): string => (i === 'separator' ? '-' : typeof i === 'object' && i !== null && 'label' in i ? String((i as { label: string }).label) : '')
const noop = (): void => {}

describe('clusterMenuItems', () => {
  it('offers only the P1 menu items', () => {
    const items = clusterMenuItems({ kind: 'Pod', onOpenInEditor: noop, onDescribe: noop, onCopyName: noop }, (k) => k)
    expect(items.map(label)).toEqual(['kube.cluster.openInEditor', 'kube.cluster.describe', '-', 'kube.cluster.copyName'])
  })

  it('leaves out open in editor when nothing handles it', () => {
    const items = clusterMenuItems({ kind: 'Pod', onDescribe: noop, onCopyName: noop }, (k) => k)
    expect(items.map(label)).toEqual(['kube.cluster.describe', '-', 'kube.cluster.copyName'])
  })

  // Spec 4.7 (board D): a Pod's second group is logs, previous logs (shell and port forward come in later parts).
  it('lists logs and previous logs for a Pod, in the second group', () => {
    const items = clusterMenuItems({ kind: 'Pod', onOpenInEditor: noop, onDescribe: noop, onCopyName: noop, onLogs: noop }, (k) => k)
    expect(items.map(label)).toEqual([
      'kube.cluster.openInEditor',
      'kube.cluster.describe',
      '-',
      'kube.logs.open',
      'kube.logs.openPrevious',
      '-',
      'kube.cluster.copyName'
    ])
  })

  it('has no logs for a Deployment', () => {
    const items = clusterMenuItems({ kind: 'Deployment', onOpenInEditor: noop, onDescribe: noop, onCopyName: noop, onLogs: noop }, (k) => k)
    expect(items.map(label)).toEqual(['kube.cluster.openInEditor', 'kube.cluster.describe', '-', 'kube.cluster.copyName'])
  })

  it('asks for previous logs only from the previous logs item', () => {
    const asked: boolean[] = []
    const items = clusterMenuItems({ kind: 'Pod', onDescribe: noop, onCopyName: noop, onLogs: (previous) => asked.push(previous) }, (k) => k)
    for (const key of ['kube.logs.open', 'kube.logs.openPrevious']) {
      const item = items.find((i) => label(i) === key) as { onSelect(): void }
      item.onSelect()
    }
    expect(asked).toEqual([false, true])
  })
})

describe('clusterMenuItems writes', () => {
  const writes = { onEdit: noop, onDelete: noop, onRestart: noop, onScale: noop }
  const kinds = (kind: string, extra: Record<string, unknown> = writes): string[] =>
    clusterMenuItems({ kind, onOpenInEditor: noop, onDescribe: noop, onCopyName: noop, ...extra }, (k) => k).map(label)

  it('offers edit and delete for every kind, restart and scale for workloads, in board D order', () => {
    expect(kinds('Deployment')).toEqual([
      'kube.cluster.openInEditor', 'kube.cluster.describe', '-', 'kube.cluster.copyName', '-',
      'kube.cluster.edit', 'kube.cluster.restart', 'kube.cluster.scale', 'kube.cluster.delete'
    ])
    expect(kinds('StatefulSet').slice(-4)).toEqual(['kube.cluster.edit', 'kube.cluster.restart', 'kube.cluster.scale', 'kube.cluster.delete'])
    expect(kinds('DaemonSet').slice(-3)).toEqual(['kube.cluster.edit', 'kube.cluster.restart', 'kube.cluster.delete'])
    expect(kinds('ConfigMap').slice(-3)).toEqual(['-', 'kube.cluster.edit', 'kube.cluster.delete'])
    expect(kinds('Pod', { ...writes, onLogs: noop })).toEqual([
      'kube.cluster.openInEditor', 'kube.cluster.describe', '-', 'kube.logs.open', 'kube.logs.openPrevious', '-', 'kube.cluster.copyName', '-',
      'kube.cluster.edit', 'kube.cluster.delete'
    ])
  })

  it('offers nothing of the writes without handlers', () => {
    expect(kinds('Deployment', {})).toEqual(['kube.cluster.openInEditor', 'kube.cluster.describe', '-', 'kube.cluster.copyName'])
  })

  it('asks for the object of the ref it was built for', () => {
    const asked: unknown[] = []
    const ref = { context: 'c', namespace: 'dev', resource: 'deployments.apps', kind: 'Deployment', name: 'web' }
    const object = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'web' } }
    const handlers = writeMenuHandlers((a) => void asked.push(a), ref, object)
    const items = clusterMenuItems({ kind: 'Deployment', onDescribe: noop, onCopyName: noop, ...handlers }, (k) => k)
    for (const key of ['edit', 'restart', 'scale', 'delete']) (items.find((i) => label(i) === `kube.cluster.${key}`) as { onSelect(): void }).onSelect()
    expect(asked).toEqual(['edit', 'restart', 'scale', 'delete'].map((verb) => ({ verb, ref, object })))
    expect(writeMenuHandlers(undefined, ref, object)).toEqual({})
  })
})

describe('the shell item', () => {
  const ref = { context: 'c', namespace: 'dev', resource: 'pods', kind: 'Pod', name: 'web-1' }
  const running = { state: { running: {} } }
  const pod = (extra: Record<string, unknown> = {}): K8sObject =>
    ({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: 'web-1', namespace: 'dev' },
      spec: { containers: [{ name: 'app' }] },
      status: { phase: 'Running', containerStatuses: [{ name: 'app', ...running }] },
      ...extra
    }) as K8sObject
  const sidecarPod = (): K8sObject =>
    pod({
      spec: { initContainers: [{ name: 'proxy', restartPolicy: 'Always' }], containers: [{ name: 'app' }] },
      status: { phase: 'Running', initContainerStatuses: [{ name: 'proxy', ...running }], containerStatuses: [{ name: 'app', ...running }] }
    })
  const t = (k: string, p?: Record<string, unknown>): string => (p ? `${k}${JSON.stringify(p)}` : k)
  const base = { kind: 'Pod', onDescribe: noop, onCopyName: noop }

  it('offers a shell for a running Pod with one container', () => {
    const opened: Array<[unknown, string]> = []
    const shell = shellChoice((r, c) => opened.push([r, c]), ref, pod())
    const items = clusterMenuItems({ ...base, shell }, t)
    expect(items.map(label)).toEqual(['kube.cluster.describe', '-', 'kube.shell.open', '-', 'kube.cluster.copyName'])
    ;(items[2] as { onSelect(): void }).onSelect()
    expect(opened).toEqual([[ref, 'app']])
  })

  it('puts the shell after logs and previous logs', () => {
    const items = clusterMenuItems({ ...base, onLogs: noop, shell: shellChoice(noop, ref, pod()) }, t)
    expect(items.map(label)).toEqual(['kube.cluster.describe', '-', 'kube.logs.open', 'kube.logs.openPrevious', 'kube.shell.open', '-', 'kube.cluster.copyName'])
  })

  it('asks which container when several run', () => {
    const opened: string[] = []
    const items = clusterMenuItems({ ...base, shell: shellChoice((_r, c) => opened.push(c), ref, sidecarPod()) }, t)
    const sub = items[2] as { label: string; submenu: unknown[] }
    expect(sub.label).toBe('kube.shell.open')
    expect(sub.submenu.map(label)).toEqual(['kube.logs.sidecarContainer{"name":"proxy"}', 'app'])
    ;(sub.submenu[1] as { onSelect(): void }).onSelect()
    expect(opened).toEqual(['app'])
  })

  it('leaves the shell out for a Pod that is not Running', () => {
    const pending = pod({ status: { phase: 'Pending' } })
    expect(shellChoice(noop, ref, pending)).toBeUndefined()
    expect(shellChoice(undefined, ref, pod())).toBeUndefined()
    expect(shellChoice(noop, ref, null)).toBeUndefined()
  })

  it('keeps the shell out of other kinds', () => {
    const items = clusterMenuItems({ ...base, kind: 'Deployment', shell: shellChoice(noop, ref, pod()) }, t)
    expect(items.map(label)).toEqual(['kube.cluster.describe', '-', 'kube.cluster.copyName'])
  })
})

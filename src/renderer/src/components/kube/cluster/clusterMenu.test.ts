import { describe, it, expect } from 'vitest'
import { clusterMenuItems } from './clusterMenu'

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

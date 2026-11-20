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
})

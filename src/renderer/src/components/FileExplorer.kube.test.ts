import { describe, it, expect, vi } from 'vitest'
import type { KubeFileKind } from '../../../core/kube/types'
import type { MenuItem, SubmenuItem } from './ContextMenu'
import { kubeMenuItems } from './FileExplorer'

const t = (k: string): string => k
const on = { compare: vi.fn(), apply: vi.fn(), reload: vi.fn(), delete: vi.fn() }

const build = (selection: string[], kinds: Record<string, KubeFileKind>, dirs: string[] = []): SubmenuItem | null => {
  const m = kubeMenuItems({
    selection,
    kinds,
    isDir: (p) => dirs.includes(p),
    heading: 'H',
    t: t as never,
    on
  })
  return m as SubmenuItem | null
}
const actions = (m: SubmenuItem): Array<Extract<MenuItem, { onSelect: () => void }>> =>
  m.submenu.filter((i): i is Extract<MenuItem, { onSelect: () => void }> => typeof i === 'object' && 'onSelect' in i)

describe('kubeMenuItems', () => {
  it('three manifests give a submenu of four actions with reload disabled', () => {
    const m = build(['/a.yaml', '/b.yaml', '/c.yaml'], { '/a.yaml': 'manifest', '/b.yaml': 'manifest', '/c.yaml': 'manifest' })!
    expect(m.submenu[0]).toEqual({ heading: 'H' })
    const a = actions(m)
    expect(a).toHaveLength(4)
    expect(a.map((i) => i.disabled ?? false)).toEqual([false, false, true, false])
    expect(a[2].title).toBe('kube.menu.reloadOnlyOne')
    expect(a[3].danger).toBe(true)
  })

  it('one manifest enables reload and wires every verb', () => {
    const m = build(['/a.yaml'], { '/a.yaml': 'manifest' })!
    const a = actions(m)
    expect(a.every((i) => !i.disabled)).toBe(true)
    a.forEach((i) => i.onSelect())
    expect([on.compare, on.apply, on.reload, on.delete].map((f) => f.mock.calls.length)).toEqual([1, 1, 1, 1])
  })

  it('a plain yaml alone gives null', () => {
    expect(build(['/values.yaml'], { '/values.yaml': 'plain' })).toBeNull()
    expect(build(['/readme.md'], {})).toBeNull()
  })

  it('a folder counts, but reload needs exactly one manifest', () => {
    const m = build(['/dir'], {}, ['/dir'])!
    expect(actions(m).map((i) => i.disabled ?? false)).toEqual([false, false, true, false])
    const k = build(['/k/kustomization.yaml'], { '/k/kustomization.yaml': 'kustomization' })!
    expect(actions(k)[2].disabled).toBe(true)
  })

  it('a kustomization says why reload is off: Kustomize files are not reloaded', () => {
    const k = build(['/k/kustomization.yaml'], { '/k/kustomization.yaml': 'kustomization' })!
    expect(actions(k)[2]).toMatchObject({ disabled: true, title: 'kube.menu.reloadKustomize' })
  })

  it('only helm templates disable everything with the helm tooltip', () => {
    const m = build(['/t.yaml'], { '/t.yaml': 'helm-template' })!
    const a = actions(m)
    expect(a.every((i) => i.disabled && i.title === 'kube.menu.helm')).toBe(true)
  })

  it('a helm template next to a manifest does not disable apply', () => {
    const m = build(['/t.yaml', '/a.yaml'], { '/t.yaml': 'helm-template', '/a.yaml': 'manifest' })!
    expect(actions(m)[1].disabled).toBeFalsy()
  })
})

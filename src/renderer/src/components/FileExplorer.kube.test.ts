import { describe, it, expect, vi } from 'vitest'
import type { KubeFileKind } from '../../../core/kube/types'
import type { MenuItem, SubmenuItem } from './ContextMenu'
import { en } from '../../../core/i18n/messages/en'
import { ko } from '../../../core/i18n/messages/ko'
import { kubeMenuAnswer, kubeMenuHeading, kubeMenuItems, type KubeMenuAsk } from './FileExplorer'

const t = (k: string): string => k
const tp = (k: string, p?: Record<string, unknown>): string => (p ? `${k}${JSON.stringify(p)}` : k)
const on = { compare: vi.fn(), apply: vi.fn(), reload: vi.fn(), delete: vi.fn() }

const build = (
  selection: string[],
  kinds: Record<string, KubeFileKind>,
  dirs: string[] = [],
  charts: string[] = []
): SubmenuItem | null => {
  const m = kubeMenuItems({
    selection,
    kinds,
    isDir: (p) => dirs.includes(p),
    isChart: (p) => charts.includes(p),
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

  it('a folder known to be in a Helm chart counts as Helm: alone or beside templates it disables everything', () => {
    const chart = build(['/chart'], {}, ['/chart'], ['/chart'])!
    expect(actions(chart).every((i) => i.disabled && i.title === 'kube.menu.helm')).toBe(true)
    const mixed = build(['/chart', '/chart2/templates/t.yaml', '/values.yaml'], { '/chart2/templates/t.yaml': 'helm-template', '/values.yaml': 'plain' }, ['/chart'], ['/chart'])!
    expect(actions(mixed).every((i) => i.disabled && i.title === 'kube.menu.helm')).toBe(true)
    // not known (yet) to be a chart, or beside something applicable: enabled
    expect(actions(build(['/chart'], {}, ['/chart'])!)[1].disabled).toBeFalsy()
    expect(actions(build(['/chart', '/a.yaml'], { '/a.yaml': 'manifest' }, ['/chart'], ['/chart'])!)[1].disabled).toBeFalsy()
    expect(actions(build(['/chart', '/k8s'], {}, ['/chart', '/k8s'], ['/chart'])!)[1].disabled).toBeFalsy()
  })
})

describe('kubeMenuHeading', () => {
  const isDir = (p: string): boolean => !p.endsWith('.yaml')
  const ARN = 'arn:aws:eks:us-east-1:123456789012:cluster/live-cluster'

  it('counts files and folders apart, leaving out a part that is zero', () => {
    const scope = (s: string[]): string => kubeMenuHeading(s, isDir, null, tp as never)
    expect(scope(['/a.yaml', '/b.yaml', '/dir'])).toBe('kube.menu.files{"count":2} · kube.menu.folderOne')
    expect(scope(['/a.yaml'])).toBe('kube.menu.fileOne')
    expect(scope(['/d1', '/d2'])).toBe('kube.menu.folders{"count":2}')
    expect(scope(['/a.yaml', '/d1', '/d2'])).toBe('kube.menu.fileOne · kube.menu.folders{"count":2}')
  })

  it('names the target once resolved: the short context name and the namespace; an ellipsis while loading; nothing unresolved', () => {
    expect(kubeMenuHeading(['/a.yaml', '/b.yaml', '/c.yaml'], isDir, { context: ARN, namespace: 'api' }, tp as never)).toBe(
      'kube.menu.target{"scope":"kube.menu.files{\\"count\\":3}","context":"live-cluster","namespace":"api"}'
    )
    expect(kubeMenuHeading(['/a.yaml'], isDir, { context: 'kind-dev', namespace: null }, tp as never)).toBe(
      'kube.menu.targetContext{"scope":"kube.menu.fileOne","context":"kind-dev"}'
    )
    expect(kubeMenuHeading(['/a.yaml'], isDir, 'loading', tp as never)).toBe('kube.menu.targetLoading{"scope":"kube.menu.fileOne"}')
    expect(kubeMenuHeading(['/a.yaml'], isDir, null, tp as never)).toBe('kube.menu.fileOne')
  })

  it('has every word in both catalogs, and the target keeps the arrow', () => {
    for (const key of ['kube.menu.files', 'kube.menu.fileOne', 'kube.menu.folders', 'kube.menu.folderOne', 'kube.menu.target', 'kube.menu.targetContext', 'kube.menu.targetLoading'] as const) {
      expect(ko[key]).toBeTruthy()
      expect(en[key]).toBeTruthy()
    }
    expect(en['kube.menu.target']).toBe('{scope} → {context} / {namespace}')
    expect(en['kube.menu.files']).toBe('{count} files')
    expect(en['kube.menu.folderOne']).toBe('1 folder')
  })
})

describe('kubeMenuAnswer: the resolver answer for the menu it was asked for', () => {
  const info = (context: string) => ({ target: { context, namespace: null }, chartFolders: [] })

  it("a menu opens loading; its own answer lands, an earlier menu's late answer does not", () => {
    const first = {}
    const second = {}
    let s: KubeMenuAsk = { menu: first, info: 'loading' }
    s = { menu: second, info: 'loading' } // the menu was opened again
    s = kubeMenuAnswer(s, first, info('old'))
    expect(s).toEqual({ menu: second, info: 'loading' })
    expect(s.menu).toBe(second)
    s = kubeMenuAnswer(s, second, info('new'))
    expect(s).toEqual({ menu: second, info: info('new') })
    // an unresolved answer (the resolver failed) shows nothing
    const third = {}
    expect(kubeMenuAnswer({ menu: third, info: 'loading' }, third, null)).toEqual({ menu: third, info: null })
  })
})

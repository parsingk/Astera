import { describe, expect, it } from 'vitest'
import { foldPathCase } from '../files/paths'
import {
  defaultRememberFolder,
  displayContextName,
  foldersUpTo,
  parseConfigView,
  resolveTarget,
  targetKey
} from './target'
import type { KubeContexts, Remembered } from './types'

const EKS = 'arn:aws:eks:ap-northeast-2:111122223333:cluster/ComeEarth-dev'
const GKE = 'gke_my-project_asia-northeast3-a_dev-cluster'
const BS = String.fromCharCode(92)
const win = (p: string) => p.split('/').join(BS)

describe('defaultRememberFolder', () => {
  it('is the first folder under the root on the file path', () => {
    expect(defaultRememberFolder('/p/live-cluster/api-server/deployment.yaml', '/p', null)).toBe('/p/live-cluster')
  })
  it('is the root for a file directly in it', () => {
    expect(defaultRememberFolder('/p/deploy.yaml', '/p', null)).toBe('/p')
  })
  it('is the overlay folder for Kustomize', () => {
    expect(
      defaultRememberFolder('/p/deploy/k8s/overlays/dev/kustomization.yaml', '/p', '/p/deploy/k8s/overlays/dev')
    ).toBe('/p/deploy/k8s/overlays/dev')
  })
  it('handles Windows paths', () => {
    expect(defaultRememberFolder(win('C:/p/live/a/d.yaml'), win('C:/p'), null)).toBe(win('C:/p/live'))
  })
})

describe('foldersUpTo', () => {
  it('lists folders nearest first, root last', () => {
    expect(foldersUpTo('/p/a/b/d.yaml', '/p')).toEqual(['/p/a/b', '/p/a', '/p'])
    expect(foldersUpTo('/p/d.yaml', '/p')).toEqual(['/p'])
  })
  it('handles Windows paths', () => {
    expect(foldersUpTo(win('C:/p/a/d.yaml'), win('C:/p'))).toEqual([win('C:/p/a'), win('C:/p')])
  })
})

describe('resolveTarget', () => {
  const contexts: KubeContexts = {
    contexts: [
      { name: 'k3s', namespace: 'web', cluster: 'k3s', provider: null },
      { name: 'dev', namespace: null, cluster: 'dev', provider: null }
    ],
    current: 'k3s'
  }
  const store = (m: Record<string, Remembered>) => (f: string) => m[f]

  it('uses a remembered ancestor', () => {
    expect(resolveTarget(['/p/a', '/p'], store({ '/p': { context: 'dev', namespace: 'x' } }), contexts)).toEqual({
      state: 'remembered',
      context: 'dev',
      namespace: 'x',
      folder: '/p'
    })
  })
  it('prefers the nearer folder', () => {
    const r = store({ '/p/a': { context: 'k3s', namespace: null }, '/p': { context: 'dev', namespace: null } })
    expect(resolveTarget(['/p/a', '/p'], r, contexts)).toMatchObject({
      state: 'remembered',
      context: 'k3s',
      folder: '/p/a'
    })
  })
  it('is missing, never current, when kubeconfig lost the context', () => {
    expect(resolveTarget(['/p'], store({ '/p': { context: 'gone', namespace: null } }), contexts)).toEqual({
      state: 'missing',
      context: 'gone',
      folder: '/p'
    })
  })
  it('falls back to the current context with its namespace', () => {
    expect(resolveTarget(['/p'], store({}), contexts)).toEqual({ state: 'current', context: 'k3s', namespace: 'web' })
  })
  it('is none with nothing remembered and no current context', () => {
    expect(resolveTarget(['/p'], store({}), { contexts: [], current: null })).toEqual({ state: 'none' })
  })
  it('is none when the current context is not listed', () => {
    expect(resolveTarget(['/p'], store({}), { contexts: [], current: 'ghost' })).toEqual({ state: 'none' })
  })
})

describe('targetKey', () => {
  it('is the same for worktrees of one repository', () => {
    const a = targetKey('/w/main/deploy/k8s', { top: '/w/main', commonDir: '/w/main/.git' })
    const b = targetKey('/w/wt/deploy/k8s', { top: '/w/wt', commonDir: '/w/main/.git' })
    expect(a).toBe('/w/main/.git|deploy/k8s')
    expect(b).toBe(a)
  })
  it('uses forward slashes on Windows paths', () => {
    expect(targetKey(win('C:/r/deploy/k8s'), { top: win('C:/r'), commonDir: 'C:/r/.git' })).toBe('c:/r/.git|deploy/k8s')
  })
  it('is the same however the Windows paths are spelled', () => {
    const a = targetKey('C:/r/Deploy/K8s'.split('/').join(BS), { top: 'C:/r'.split('/').join(BS), commonDir: 'C:/r/.git' })
    const b = targetKey('c:/r/deploy/k8s'.split('/').join(BS), { top: 'c:/R'.split('/').join(BS), commonDir: win('c:/r/.git') })
    expect(a).toBe('c:/r/.git|deploy/k8s')
    expect(b).toBe(a)
  })
  it('falls back to the folded absolute path for a folder outside the top', () => {
    expect(targetKey('/w/other/x', { top: '/w/main', commonDir: '/w/main/.git' })).toBe(foldPathCase('/w/other/x'))
    expect(targetKey(win('D:/x'), { top: win('C:/r'), commonDir: 'C:/r/.git' })).toBe(win('d:/x'))
  })
  it('is empty after the bar at the top of the repository', () => {
    expect(targetKey('/w/main', { top: '/w/main', commonDir: '/w/main/.git' })).toBe('/w/main/.git|')
  })
  it('is the case-folded absolute path outside git', () => {
    expect(targetKey('/Some/Dir', null)).toBe(foldPathCase('/Some/Dir'))
    // A Windows path folds on every host (foldKeyPart), not only where the host folds case
    expect(targetKey(win('C:/Some/Dir'), null)).toBe(win('c:/some/dir'))
  })
})

describe('parseConfigView', () => {
  const json = JSON.stringify({
    'current-context': 'dlar4-k3s',
    clusters: [
      {
        name: 'ComeEarth-dev.ap-northeast-2.eksctl.io',
        cluster: { server: 'https://ABC.gr7.ap-northeast-2.eks.amazonaws.com' }
      },
      { name: GKE, cluster: { server: 'https://35.1.2.3' } },
      { name: 'k3s-c', cluster: { server: 'https://10.0.0.1:6443' } }
    ],
    contexts: [
      { name: EKS, context: { cluster: 'ComeEarth-dev.ap-northeast-2.eksctl.io', user: 'u', namespace: 'prod' } },
      { name: GKE, context: { cluster: GKE, user: 'g' } },
      { name: 'dlar4-k3s', context: { cluster: 'k3s-c', user: 'k' } }
    ]
  })
  it('reads names, namespaces, providers and current', () => {
    expect(parseConfigView(json)).toEqual({
      current: 'dlar4-k3s',
      contexts: [
        { name: EKS, namespace: 'prod', cluster: 'ComeEarth-dev.ap-northeast-2.eksctl.io', provider: 'eks' },
        { name: GKE, namespace: null, cluster: GKE, provider: 'gke' },
        { name: 'dlar4-k3s', namespace: null, cluster: 'k3s-c', provider: null }
      ]
    })
  })
  it('detects EKS by server host even when the name is plain', () => {
    const j = JSON.stringify({
      clusters: [{ name: 'c', cluster: { server: 'https://X.eks.amazonaws.com' } }],
      contexts: [{ name: 'plain', context: { cluster: 'c' } }]
    })
    expect(parseConfigView(j)).toEqual({
      current: null,
      contexts: [{ name: 'plain', namespace: null, cluster: 'c', provider: 'eks' }]
    })
  })
  it('returns empty on unparsable or odd input', () => {
    expect(parseConfigView('not json')).toEqual({ contexts: [], current: null })
    expect(parseConfigView('null')).toEqual({ contexts: [], current: null })
    expect(parseConfigView('{}')).toEqual({ contexts: [], current: null })
  })
})

describe('displayContextName', () => {
  it('shortens an EKS ARN to cluster and region', () => {
    expect(displayContextName('arn:aws:eks:ap-northeast-2:111:cluster/Live')).toEqual({
      short: 'Live',
      detail: 'ap-northeast-2'
    })
    expect(displayContextName(EKS)).toEqual({ short: 'ComeEarth-dev', detail: 'ap-northeast-2' })
  })
  it('shortens a GKE name to cluster and zone', () => {
    expect(displayContextName(GKE)).toEqual({ short: 'dev-cluster', detail: 'asia-northeast3-a' })
  })
  it('keeps other names', () => {
    expect(displayContextName('dlar4-k3s')).toEqual({ short: 'dlar4-k3s', detail: null })
  })
})

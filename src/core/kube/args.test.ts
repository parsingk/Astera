import { describe, expect, it } from 'vitest'
import { configViewArgs, getOneArgs, kubectlArgs, kustomizeArgs, useContextArgs } from './args'
import type { KubeCommand } from './types'

const files: KubeCommand = { kind: 'files', files: ['a.yaml', 'b.yaml'] }
const overlay: KubeCommand = { kind: 'overlay', dir: 'k/dev' }
const t = { context: 'ctx', nsFlag: 'api' }

describe('kubectlArgs', () => {
  it('apply puts the namespace after the context and one -f per file', () => {
    expect(kubectlArgs('apply', files, t)).toEqual(['apply', '--context', 'ctx', '-n', 'api', '-f', 'a.yaml', '-f', 'b.yaml'])
  })
  it('dry-apply asks the server for yaml', () => {
    expect(kubectlArgs('dry-apply', files, t)).toEqual([
      'apply', '--dry-run=server', '-o', 'yaml', '--context', 'ctx', '-n', 'api', '-f', 'a.yaml', '-f', 'b.yaml'
    ])
  })
  it('delete and dry-delete ignore missing objects; only the real delete does not wait for finalizers', () => {
    expect(kubectlArgs('delete', files, t)).toEqual([
      'delete', '--ignore-not-found', '--wait=false', '--context', 'ctx', '-n', 'api', '-f', 'a.yaml', '-f', 'b.yaml'
    ])
    expect(kubectlArgs('dry-delete', files, t).slice(0, 2)).toEqual(['delete', '--dry-run=server'])
    expect(kubectlArgs('dry-delete', files, t)).toContain('--ignore-not-found')
    expect(kubectlArgs('dry-delete', files, t)).not.toContain('--wait=false')
  })
  it('live reads the cluster state as yaml', () => {
    expect(kubectlArgs('live', files, t)).toEqual([
      'get', '--ignore-not-found', '-o', 'yaml', '--context', 'ctx', '-n', 'api', '-f', 'a.yaml', '-f', 'b.yaml'
    ])
  })
  it('an overlay is -k and a null namespace omits -n', () => {
    expect(kubectlArgs('apply', overlay, { context: 'ctx', nsFlag: null })).toEqual(['apply', '--context', 'ctx', '-k', 'k/dev'])
  })
  it('keeps ARNs, spaces and Korean untouched', () => {
    const bs = String.fromCharCode(92)
    const p = ['C:', 'Users', 'me', '새 폴더', 'a b.yaml'].join(bs)
    const ctx = 'arn:aws:eks:ap-northeast-2:1:cluster/X'
    expect(kubectlArgs('apply', { kind: 'files', files: [p] }, { context: ctx, nsFlag: null })).toEqual(['apply', '--context', ctx, '-f', p])
  })
})

describe('small builders', () => {
  it('builds the config and lookup commands', () => {
    expect(useContextArgs('ctx')).toEqual(['config', 'use-context', 'ctx'])
    expect(configViewArgs()).toEqual(['config', 'view', '-o', 'json'])
    expect(kustomizeArgs('k/dev')).toEqual(['kustomize', 'k/dev'])
    expect(getOneArgs('Deployment', 'web', 'api', 'ctx')).toEqual(['get', 'Deployment', 'web', '--ignore-not-found', '-o', 'yaml', '--context', 'ctx', '-n', 'api'])
    expect(getOneArgs('Namespace', 'x', null, 'ctx')).not.toContain('-n')
  })
})

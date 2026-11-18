import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { kubeEnv, kubectlDisplayPath } from './runtime'

const d = path.delimiter

describe('kubeEnv', () => {
  it('passes the parent env untouched when no file was added', () => {
    const parent = { KUBECONFIG: 'a', X: '1' }
    expect(kubeEnv([], parent, '/home/u')).toBe(parent)
  })

  it('puts the added files after the default ~/.kube/config when KUBECONFIG is unset', () => {
    const env = kubeEnv(['/x/one', '/x/two'], { X: '1' }, '/home/u')
    expect(env.KUBECONFIG).toBe([path.join('/home/u', '.kube', 'config'), '/x/one', '/x/two'].join(d))
    expect(env.X).toBe('1')
  })

  it('keeps the parent KUBECONFIG list first and drops duplicates', () => {
    const env = kubeEnv(['/b', '/c'], { KUBECONFIG: ['/a', '/b'].join(d) }, '/home/u')
    expect(env.KUBECONFIG).toBe(['/a', '/b', '/c'].join(d))
  })
})

describe('kubectlDisplayPath', () => {
  const dir = path.resolve('/opt/tools')
  const env = { PATH: ['relative', dir].join(d) }

  it('shows the override as given', () => {
    expect(kubectlDisplayPath('/custom/kubectl', env, () => true)).toBe('/custom/kubectl')
  })

  // On Windows the bin is already resolved by windowsExecutable from the real PATH, so the walk is POSIX only.
  it.skipIf(process.platform === 'win32')('shows where an absolute PATH folder holds the binary, skipping relative folders', () => {
    const seen: string[] = []
    const found = kubectlDisplayPath(null, env, (p) => (seen.push(p), p.startsWith(dir)))
    expect(path.dirname(found)).toBe(dir)
    expect(seen.every((p) => path.isAbsolute(p))).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('falls back to the bare name when PATH has no kubectl', () => {
    expect(kubectlDisplayPath(null, env, () => false)).toBe('kubectl')
  })
})

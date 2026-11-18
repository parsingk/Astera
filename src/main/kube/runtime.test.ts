import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { kubeEnv } from './runtime'

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

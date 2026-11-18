import { describe, expect, it } from 'vitest'
import { parseKubectlOutput } from './output'

describe('parseKubectlOutput', () => {
  it('reads the four success outcomes', () => {
    const stdout = [
      'deployment.apps/api-server configured',
      'service/api-server unchanged',
      'namespace/x created',
      'ingress.networking.k8s.io/y deleted'
    ].join('\n')
    expect(parseKubectlOutput(stdout, '')).toEqual([
      { ref: 'deployment.apps/api-server', outcome: 'configured' },
      { ref: 'service/api-server', outcome: 'unchanged' },
      { ref: 'namespace/x', outcome: 'created' },
      { ref: 'ingress.networking.k8s.io/y', outcome: 'deleted' }
    ])
  })

  it('accepts a server dry run suffix', () => {
    expect(parseKubectlOutput('service/a configured (server dry run)\n', '')).toEqual([
      { ref: 'service/a', outcome: 'configured' }
    ])
  })

  it('treats an unknown verb as configured', () => {
    expect(parseKubectlOutput('configmap/x serverside-applied', '')).toEqual([
      { ref: 'configmap/x', outcome: 'configured' }
    ])
  })

  it('splits an error that names its file', () => {
    const line =
      'Error from server (BadRequest): error when creating "api-server/ingress.yaml": admission webhook "v" denied the request: bad'
    expect(parseKubectlOutput('', line)).toEqual([
      {
        ref: '',
        outcome: 'error',
        file: 'api-server/ingress.yaml',
        message: 'admission webhook "v" denied the request: bad'
      }
    ])
  })

  it('keeps a file-less error line whole', () => {
    const line =
      `error: the namespace from the provided object "web" does not match the namespace "api". You must pass '--namespace=web' to perform this operation.`
    expect(parseKubectlOutput('', line)).toEqual([{ ref: '', outcome: 'error', message: line }])
  })

  it('keeps continuation lines and drops warnings and blanks', () => {
    const stderr = 'Warning: something deprecated\n\nerror: first\n  detail line\n'
    expect(parseKubectlOutput('', stderr)).toEqual([
      { ref: '', outcome: 'error', message: 'error: first' },
      { ref: '', outcome: 'error', message: 'detail line' }
    ])
  })

  it('parses Windows line endings the same', () => {
    const out = 'service/a created\r\nnamespace/b unchanged\r\n'
    const err = 'Error from server (Invalid): error when creating "a.yaml": bad\r\n'
    expect(parseKubectlOutput(out, err)).toEqual([
      { ref: 'service/a', outcome: 'created' },
      { ref: 'namespace/b', outcome: 'unchanged' },
      { ref: '', outcome: 'error', file: 'a.yaml', message: 'bad' }
    ])
  })
})

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

  it('maps the whitelisted variant verbs and keeps the verb as message', () => {
    expect(
      parseKubectlOutput(['configmap/x serverside-applied', 'service/y patched', 'pod/z pruned'].join('\n'), '')
    ).toEqual([
      { ref: 'configmap/x', outcome: 'configured', message: 'serverside-applied' },
      { ref: 'service/y', outcome: 'configured', message: 'patched' },
      { ref: 'pod/z', outcome: 'deleted', message: 'pruned' }
    ])
  })

  it('reads replaced, restarted and scaled as configured with the word as message', () => {
    expect(
      parseKubectlOutput(['deployment.apps/web replaced', 'deployment.apps/web restarted', 'deployment.apps/web scaled'].join('\n'), '')
    ).toEqual([
      { ref: 'deployment.apps/web', outcome: 'configured', message: 'replaced' },
      { ref: 'deployment.apps/web', outcome: 'configured', message: 'restarted' },
      { ref: 'deployment.apps/web', outcome: 'configured', message: 'scaled' }
    ])
  })

  it('reads plain delete output with a quoted name', () => {
    expect(
      parseKubectlOutput(['deployment.apps "api-server" deleted', 'service "web" deleted (server dry run)'].join('\n'), '')
    ).toEqual([
      { ref: 'deployment.apps/api-server', outcome: 'deleted' },
      { ref: 'service/web', outcome: 'deleted' }
    ])
  })

  it('accepts dotted names', () => {
    expect(parseKubectlOutput('configmap/app.config configured', '')).toEqual([
      { ref: 'configmap/app.config', outcome: 'configured' }
    ])
  })

  it('turns an unknown verb or a success-shaped stray line into an error', () => {
    expect(parseKubectlOutput('', ['./x.yaml missing', 'service/a exploded'].join('\n'))).toEqual([
      { ref: '', outcome: 'error', message: './x.yaml missing' },
      { ref: '', outcome: 'error', message: 'service/a exploded' }
    ])
  })

  it('reports a Warning line as a warning', () => {
    expect(parseKubectlOutput('', 'Warning: resource lacks the last-applied annotation')).toEqual([
      { ref: '', outcome: 'warning', message: 'resource lacks the last-applied annotation' }
    ])
  })

  it('keeps a file path with spaces and Korean characters', () => {
    const file = 'my app/배포 설정.yaml'
    const line = `Error from server (Invalid): error when creating "${file}": bad`
    expect(parseKubectlOutput('', line)).toEqual([{ ref: '', outcome: 'error', file, message: 'bad' }])
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

  it('keeps continuation lines and drops blanks', () => {
    const stderr = '\nerror: first\n  detail line\n'
    expect(parseKubectlOutput('', stderr)).toEqual([
      { ref: '', outcome: 'error', message: 'error: first' },
      { ref: '', outcome: 'error', message: 'detail line' }
    ])
  })

  it('after a successful exit, a line it does not know is a warning, not an error', () => {
    const notice = 'Please be patient while the credential plugin refreshes your token'
    expect(parseKubectlOutput('configmap/a created\n', notice, true)).toEqual([
      { ref: 'configmap/a', outcome: 'created' },
      { ref: '', outcome: 'warning', message: notice }
    ])
    // the same line after a failed exit stays an error
    expect(parseKubectlOutput('', notice, false)).toEqual([{ ref: '', outcome: 'error', message: notice }])
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

import { describe, expect, it } from 'vitest'
import { runKubectl, kubectlBin } from './kubectl'

const node = process.execPath
const js = (code: string, ...rest: string[]): string[] => ['-e', code, ...rest]

describe('runKubectl', () => {
  it('reports a non-zero exit with its code and untouched stdout', async () => {
    const r = await runKubectl(js("process.stdout.write('x '); process.exit(1)"), { bin: node })
    expect(r.ok).toBe(false)
    expect(r.stdout).toBe('x ')
    expect(r.exitCode).toBe(1)
    expect(r.timedOut).toBeUndefined()
    expect(r.errorCode).toBeUndefined()
  })

  it('passes an argument with Korean and spaces through unchanged', async () => {
    const arg = '새 폴더/a b.yaml'
    const r = await runKubectl(js('process.stdout.write(process.argv[1])', arg), { bin: node })
    expect(r.ok).toBe(true)
    expect(r.stdout).toBe(arg)
  })

  it('ends at its deadline with timedOut', async () => {
    const t0 = Date.now()
    const r = await runKubectl(js('setTimeout(() => {}, 60000)'), { bin: node, timeoutMs: 200 })
    expect(r.ok).toBe(false)
    expect(r.timedOut).toBe(true)
    expect(r.exitCode).toBeUndefined()
    expect(Date.now() - t0).toBeLessThan(6000)
  })

  it('does not wait for a grandchild that holds the pipes', async () => {
    const code =
      "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{},20000)'], { stdio: 'inherit' }); setTimeout(() => {}, 60000)"
    const t0 = Date.now()
    const r = await runKubectl(js(code), { bin: node, timeoutMs: 300 })
    expect(r.timedOut).toBe(true)
    expect(Date.now() - t0).toBeLessThan(6000)
  })

  it('answers cancelled for an aborted signal', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await runKubectl(js('setTimeout(() => {}, 60000)'), { bin: node, signal: ac.signal })
    expect(r.ok).toBe(false)
    expect(r.cancelled).toBe(true)
  })

  it('answers cancelled when aborted while running', async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 200)
    const r = await runKubectl(js('setTimeout(() => {}, 60000)'), { bin: node, signal: ac.signal })
    expect(r.cancelled).toBe(true)
  })

  it('reports ENOENT for a binary that does not exist', async () => {
    const r = await runKubectl(['version'], { bin: node + '-does-not-exist' })
    expect(r.ok).toBe(false)
    expect(r.errorCode).toBe('ENOENT')
    expect(r.exitCode).toBeUndefined()
  })

  it('hands the given env to the child', async () => {
    const r = await runKubectl(js('process.stdout.write(process.env.KUBECONFIG ?? "")'), {
      bin: node,
      env: { ...process.env, KUBECONFIG: 'a' }
    })
    expect(r.stdout).toBe('a')
  })

  // Spec 4.6.1: objects applied first go to `kubectl apply -f -` on stdin; kubectl reads until stdin closes.
  it('writes input to stdin and closes it', async () => {
    const r = await runKubectl(
      js("let s='';process.stdin.on('data',(d)=>{s+=d}).on('end',()=>process.stdout.write(s.toUpperCase()))"),
      { bin: node, input: 'kind: Namespace', timeoutMs: 10_000 }
    )
    expect(r).toMatchObject({ ok: true, stdout: 'KIND: NAMESPACE' })
  })
})

describe('kubectlBin', () => {
  it('returns the override when set', () => {
    expect(kubectlBin('/opt/kubectl')).toBe('/opt/kubectl')
  })
  it('falls back to a kubectl executable when there is no override', () => {
    expect(kubectlBin(null)).toMatch(/kubectl/)
  })
})

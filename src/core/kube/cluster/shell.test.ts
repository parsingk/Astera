import { describe, expect, it } from 'vitest'
import type { K8sObject } from '../objects'
import { SHELL_SCRIPT, canShell, shellArgs, shellContainers } from './shell'

const ref = { context: 'kind-x', namespace: 'api', resource: 'pods', kind: 'Pod', name: 'web-1' }

const running = { running: { startedAt: '2026-11-22T00:00:00Z' } }
const waiting = { waiting: { reason: 'CrashLoopBackOff' } }
const terminated = { terminated: { exitCode: 0 } }
const states = { running, waiting, terminated }

function pod(spec: object, status: object): K8sObject {
  return { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'web-1', namespace: 'api' }, spec, status } as unknown as K8sObject
}

function podIn(phase: string, s: { [name: string]: keyof typeof states }): K8sObject {
  const names = Object.keys(s)
  return pod(
    { containers: names.map((name) => ({ name })) },
    { phase, containerStatuses: names.map((name) => ({ name, state: states[s[name]] })) }
  )
}

describe('shell rules', () => {
  it('builds the exec arguments with the context before the command', () => {
    expect(shellArgs(ref, 'app')).toEqual([
      'exec', '-i', '-t', 'web-1', '-n', 'api', '-c', 'app', '--context', 'kind-x', '--', 'sh', '-c', SHELL_SCRIPT
    ])
  })
  it('keeps the script free of characters Windows quoting changes', () => {
    expect(SHELL_SCRIPT).not.toMatch(/["\\]/)
  })
  it('lists the running containers and sidecars', () => {
    const p = pod(
      { initContainers: [{ name: 'setup' }, { name: 'proxy', restartPolicy: 'Always' }], containers: [{ name: 'app' }] },
      {
        phase: 'Running',
        initContainerStatuses: [{ name: 'setup', state: terminated }, { name: 'proxy', state: running }],
        containerStatuses: [{ name: 'app', state: running }]
      }
    )
    expect(shellContainers(p)).toEqual([{ name: 'proxy', init: false, sidecar: true }, { name: 'app', init: false }])
  })
  it('leaves out a waiting container', () => {
    expect(shellContainers(podIn('Running', { app: 'running', worker: 'waiting' })).map((c) => c.name)).toEqual(['app'])
  })
  it('offers a shell only for a Running Pod with a running container', () => {
    expect(canShell(podIn('Pending', { app: 'running' }))).toBe(false)
    expect(canShell(podIn('Running', { app: 'waiting' }))).toBe(false)
    expect(canShell(podIn('Running', { app: 'running', worker: 'waiting' }))).toBe(true)
    expect(canShell(podIn('Succeeded', { app: 'terminated' }))).toBe(false)
  })
})

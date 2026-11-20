// The log view's kubectl for as long as it is mounted (review focus 5): closing the tab stops it, and picking another
// container or previous starts another. This suite has no DOM, so the view is called as a function with a stand-in for
// React's hooks (as FindingsSection.reload.test.ts does): each call is a render that reads the state the last one left,
// then the effects React would run, by their dependencies. The stream goes through the real log client (Task 4) to a
// fake window.api.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ReactElement } from 'react'
import type { LogMessage } from '../../../../../core/kube/cluster/types'

const hooks = vi.hoisted(() => {
  let slots: unknown[] = []
  let at = 0
  let effects: Array<{ run: () => unknown; deps?: unknown[] }> = []
  let mounted: Array<{ deps?: unknown[]; cleanup: unknown }> = []
  return {
    reset(): void {
      slots = []
      at = 0
      effects = []
      mounted = []
    },
    /** One render, then each effect whose dependencies changed, after the cleanup its last run left. */
    render<R>(component: () => R): R {
      at = 0
      effects = []
      const out = component()
      effects.forEach((e, k) => {
        const last = mounted[k]
        if (last !== undefined && e.deps !== undefined && last.deps !== undefined && e.deps.every((d, j) => Object.is(d, last.deps![j]))) return
        if (typeof last?.cleanup === 'function') (last.cleanup as () => void)()
        mounted[k] = { deps: e.deps, cleanup: e.run() }
      })
      return out
    },
    /** The tab goes: every effect's cleanup runs. */
    unmount(): void {
      for (const m of mounted) if (typeof m.cleanup === 'function') (m.cleanup as () => void)()
      mounted = []
    },
    useState<T>(init: T | (() => T)): [T, (v: T | ((old: T) => T)) => void] {
      const k = at++
      if (!(k in slots)) slots[k] = typeof init === 'function' ? (init as () => T)() : init
      return [slots[k] as T, (v) => void (slots[k] = typeof v === 'function' ? (v as (old: T) => T)(slots[k] as T) : v)]
    },
    useRef<T>(init: T): { current: T } {
      const k = at++
      if (!(k in slots)) slots[k] = { current: init }
      return slots[k] as { current: T }
    },
    useEffect(run: () => unknown, deps?: unknown[]): void {
      effects.push({ run, deps })
    },
    useMemo: <T>(make: () => T): T => make(),
    useCallback: <T>(fn: T): T => fn
  }
})

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>()
  return {
    ...real,
    useState: hooks.useState,
    useRef: hooks.useRef,
    useEffect: hooks.useEffect,
    useLayoutEffect: hooks.useEffect,
    useMemo: hooks.useMemo,
    useCallback: hooks.useCallback
  }
})
vi.mock('../../../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'en', t: (key: string, p?: Record<string, unknown>) => (p ? `${key}${JSON.stringify(p)}` : key) })
}))

import { KubeLogView } from './KubeLogView'

/** Every element of a rendered tree, depth first. */
function elements(node: unknown): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (node === null || typeof node !== 'object' || !('props' in node)) return []
  const el = node as ReactElement<{ children?: unknown }>
  return [el, ...elements(el.props.children)]
}
function textOf(node: unknown): string {
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (node === null || typeof node !== 'object' || !('props' in node)) return ''
  return textOf((node as ReactElement<{ children?: unknown }>).props.children)
}
const byLabel = (tree: unknown, label: string): ReactElement<Record<string, unknown>> => {
  const hit = elements(tree).find((e) => (e.props as Record<string, unknown>)['aria-label'] === label)
  if (!hit) throw new Error(`no element labelled ${label}`)
  return hit as ReactElement<Record<string, unknown>>
}
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const target = { context: 'kind-dev', namespace: 'api', resource: 'pods', kind: 'Pod', name: 'worker-1' }
const pod = {
  apiVersion: 'v1',
  kind: 'Pod',
  metadata: { name: 'worker-1', namespace: 'api' },
  spec: { containers: [{ name: 'worker' }, { name: 'sidecar' }] },
  status: { containerStatuses: [{ name: 'worker', state: { running: {} } }] }
}

let api: ReturnType<typeof fakeApi>
function fakeApi() {
  const listeners = new Set<(m: LogMessage) => void>()
  const started: Array<{ id: string; container: string; previous: boolean }> = []
  const stopped: string[] = []
  const reads: unknown[] = []
  let answer: unknown = { ok: true, object: pod }
  return {
    window: {
      api: {
        kube: {
          logs: {
            start: async (id: string, spec: { options: { container: string; previous: boolean } }) => {
              started.push({ id, container: spec.options.container, previous: spec.options.previous })
            },
            stop: async (id: string) => {
              stopped.push(id)
            },
            save: async () => ({ saved: false })
          },
          cluster: {
            get: async (r: unknown) => {
              reads.push(r)
              return answer
            }
          }
        },
        on: (_channel: string, cb: (m: LogMessage) => void) => {
          listeners.add(cb)
          return () => void listeners.delete(cb)
        }
      }
    },
    emit: (m: LogMessage) => [...listeners].forEach((cb) => cb(m)),
    answer: (a: unknown) => void (answer = a),
    listeners,
    started,
    stopped,
    reads
  }
}

const view = () => KubeLogView({ pod, target, initial: { container: 'worker', previous: false }, visible: true })

beforeEach(() => {
  hooks.reset()
  api = fakeApi()
  vi.stubGlobal('window', api.window)
})
afterEach(() => {
  hooks.unmount()
  vi.unstubAllGlobals()
})

describe('KubeLogView stream', () => {
  it('stops its stream on unmount', () => {
    hooks.render(view)
    expect(api.started).toHaveLength(1)
    expect(api.listeners.size).toBe(1)
    hooks.unmount()
    expect(api.stopped).toEqual([api.started[0].id])
    expect(api.listeners.size).toBe(0)
  })

  it('restarts its stream when the container or previous changes', () => {
    const tree = hooks.render(view)
    ;(byLabel(tree, 'kube.logs.container').props.onChange as (e: unknown) => void)({ target: { value: 'sidecar' } })
    const next = hooks.render(view)
    expect(api.started.map((s) => s.container)).toEqual(['worker', 'sidecar'])
    expect(api.stopped).toEqual([api.started[0].id])
    ;(byLabel(next, 'kube.logs.previous').props.onClick as () => void)()
    hooks.render(view)
    expect(api.started[2]).toMatchObject({ container: 'sidecar', previous: true })
    expect(api.stopped).toEqual([api.started[0].id, api.started[1].id])
  })

  it('reads the Pod again when the stream ends, for its exit code', async () => {
    hooks.render(view)
    api.answer({
      ok: true,
      object: { ...pod, status: { containerStatuses: [{ name: 'worker', state: { terminated: { exitCode: 137, finishedAt: '2026-11-20T01:12:11Z' } } }] } }
    })
    api.emit({ logId: api.started[0].id, kind: 'ended' })
    expect(textOf(hooks.render(view))).toContain('kube.logs.streamEnded')
    expect(api.reads).toEqual([target])
    await settle()
    expect(textOf(hooks.render(view))).toContain('kube.logs.ended{"code":137}')
  })
})

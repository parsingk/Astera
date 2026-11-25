/** The Pods behind a port forward, watched so a forward whose Pod was deleted is told at once.
 *
 *  kubectl port-forward notices a deleted Pod only when the next connection arrives: until then the row said Connected
 *  for a forward that could no longer carry anything (measured on macOS with kind, kubectl 1.34: a rollout restart left
 *  it Connected until the first request, which then failed and ended kubectl). The registry (forwards.ts) is told when
 *  one of these Pods is deleted and opens one connection, which makes kubectl find out and end. */
import { listArgs } from '../../core/kube/cluster/args'
import { podSelectorOf } from '../../core/kube/cluster/summary'
import { createJsonSplitter, toWatchEvents } from '../../core/kube/cluster/watch'
import type { ObjectRef, Read } from '../../core/kube/cluster/types'
import type { K8sObject } from '../../core/kube/objects'
import type { KubectlStream, StreamExit } from '../../core/kube/stream'

interface Handlers {
  onStdout(c: string): void
  onStderr(c: string): void
  onExit(e: StreamExit): void
}

/** A watch that ran at least this long ended because the API server closed it (it does after half an hour or so), and is
 *  started again; one that ended sooner failed (no rights to watch Pods, a cluster gone), and is left ended. */
export const WATCH_RESTART_MIN_MS = 60_000

/** kubectl's watch of the Pods a forward to `ref` can be attached to: the Pod itself, or those a Deployment's or a
 *  Service's selector picks (kubectl attaches to one of them). Null when they cannot be named. */
function podWatchArgs(ref: ObjectRef, target: K8sObject | null): string[] | null {
  if (ref.namespace === null) return null
  if (ref.kind === 'Pod') {
    return listArgs({ context: ref.context, namespace: ref.namespace, namespaced: true, resource: 'pods', name: ref.name }, true)
  }
  const selector = target === null ? null : podSelectorOf(ref.kind, target)
  if (selector === null) return null
  return ['get', 'pods', '-n', ref.namespace, '-l', selector, '-o', 'json', '--watch', '--output-watch-events', '--context', ref.context]
}

export function createForwardPodWatch(deps: {
  /** The target read once, for its selector (cluster.ts `get`); a Pod target is not read. */
  get(ref: ObjectRef): Promise<Read<{ object: K8sObject | null }>>
  stream(args: string[], h: Handlers): KubectlStream
  now(): number
}): (ref: ObjectRef, onGone: () => void) => { stop(): void } {
  return (ref, onGone) => {
    let stopped = false
    let stream: KubectlStream | null = null

    const run = (args: string[]): void => {
      const startedAt = deps.now()
      const split = createJsonSplitter()
      stream = deps.stream(args, {
        onStdout(chunk) {
          if (stopped) return
          for (const parsed of split.push(chunk)) {
            if (!parsed.ok) continue
            if (toWatchEvents(parsed.value).some((e) => e.type === 'DELETED')) onGone()
          }
        },
        onStderr() {},
        onExit(x) {
          stream = null
          if (stopped || x.stopped) return
          if (deps.now() - startedAt >= WATCH_RESTART_MIN_MS) run(args)
        }
      })
    }

    if (ref.kind === 'Pod') {
      const args = podWatchArgs(ref, null)
      if (args) run(args)
    } else {
      void deps
        .get(ref)
        .then((r) => {
          if (stopped || !r.ok) return
          const args = podWatchArgs(ref, r.object)
          if (args) run(args)
        })
        .catch(() => {})
    }

    return {
      stop() {
        stopped = true
        stream?.stop()
        stream = null
      }
    }
  }
}

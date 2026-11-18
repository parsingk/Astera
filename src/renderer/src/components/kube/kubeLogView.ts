import type { KubeRequest, KubeRunResult } from '../../../../core/kube/types'
import { resolveRelative } from '../../../../core/files/paths'
import { shellQuote } from '../../lib/shellQuote'
import { touchesSelection, type KubeLogEntry } from '../../hooks/useKubeOps'

const SUCCESS = new Set(['created', 'configured', 'unchanged', 'deleted'])

export type KubeBadge =
  | { kind: 'running' | 'done' | 'cancelled' | 'timedOut' | 'refused' }
  | { kind: 'failed'; count: number }

const errorCount = (r: KubeRunResult): number => r.outcomes.filter((o) => o.outcome === 'error').length

/** The status badge of one log entry. A result that says why nothing finished never reads as running. */
export function kubeBadge(e: KubeLogEntry): KubeBadge {
  const r = e.result
  if (e.state === 'running') return { kind: 'running' }
  if (!r) return { kind: 'done' }
  if (r.refused) return { kind: 'refused' }
  if (r.cancelled) return { kind: 'cancelled' }
  if (r.timedOut) return { kind: 'timedOut' }
  if (!r.ok) return { kind: 'failed', count: Math.max(1, errorCount(r)) }
  return { kind: 'done' }
}

/** A finished operation that did not succeed. The tab's badge counts these entries. */
export const kubeFailed = (e: KubeLogEntry): boolean => e.state === 'done' && !!e.result && !e.result.ok

export const kubeFailureCount = (log: readonly KubeLogEntry[]): number => log.filter(kubeFailed).length

/** The entry shown expanded at first: the newest finished one (the log is newest first). */
export const defaultExpandedId = (log: readonly KubeLogEntry[]): string | null => log.find((e) => e.state === 'done')?.id ?? null

const isAbsolute = (p: string): boolean => p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:[\/]/.test(p)

/** The files named by an error outcome, absolute (a relative one resolves against the request's project root). */
export function failedFiles(result: KubeRunResult, projectRoot: string): string[] {
  const out: string[] = []
  for (const o of result.outcomes) {
    if (o.outcome !== 'error' || !o.file) continue
    const abs = isAbsolute(o.file) || !projectRoot ? o.file : resolveRelative(`${projectRoot}/_`, o.file)
    if (!out.includes(abs)) out.push(abs)
  }
  return out
}

/** The explorer's failure marks after a finished run: its error files are added, and the selection's files that had no
 *  error are removed. A refused run touched nothing; a cancelled or timed-out one proves nothing about the files that
 *  did not report, so it only adds. */
export function nextFailedPaths(prev: ReadonlySet<string>, result: KubeRunResult, req: KubeRequest | undefined): Set<string> {
  if (result.refused || !req) return new Set(prev)
  const failed = failedFiles(result, req.projectRoot)
  const next = new Set(prev)
  if (!result.cancelled && !result.timedOut) {
    for (const p of prev) if (touchesSelection(p, req.selection) && !failed.includes(p)) next.delete(p)
  }
  for (const f of failed) next.add(f)
  return next
}

type T = (key: never, params?: Record<string, string | number>) => string

/** The toast a finished apply, delete or reload gets, or null when none is due (compare, or a run whose preview
 *  asked again because the files changed: the dialog says so itself). */
export function kubeToastOf(
  result: KubeRunResult,
  t: T
): { kind: 'success' | 'error'; message: string } | null {
  if (result.refused?.reason === 'changed') return null
  const context = result.context
  const done = t(`kube.toast.${result.verb === 'delete' ? 'deleted' : result.verb === 'reload' ? 'reloaded' : 'applied'}` as never, { context })
  if (result.ok) return { kind: 'success', message: done }
  // A failed reload already has its own toast with the reason.
  if (result.verb === 'reload') return null
  if (result.refused) return { kind: 'error', message: t('kube.toast.refused' as never, { context }) }
  if (result.cancelled) return { kind: 'error', message: t('kube.toast.cancelled' as never, { context }) }
  if (result.timedOut) return { kind: 'error', message: t('kube.toast.timedOut' as never, { context }) }
  const ok = result.outcomes.filter((o) => SUCCESS.has(o.outcome)).length
  return { kind: 'error', message: t('kube.toast.partial' as never, { done, ok, failed: Math.max(1, errorCount(result)) }) }
}

/** "HH:MM:SS" in local time. */
export function clockText(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** One command as the person would type it. Same quoting the confirmation shows. */
export const kubeCommandText = (args: string[], platform: string): string =>
  `kubectl ${args.map((a) => shellQuote(a, platform)).join(' ')}`

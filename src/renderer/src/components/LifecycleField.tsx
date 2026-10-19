// The GitHub lifecycle's field in New Job and in issue → Job (GitHub lifecycle design §8, G7a): off by default. On, the
// folder is checked first (`github-preflight`, the Host's run-create preflight asked alone) and the defaults the Job
// will take are said beside it, so a person learns before Create whether this folder can carry the Job and how.
import { useEffect, useRef, useState } from 'react'
import type { GitHubLifecycleDefaults } from '../../../core/github/lifecycleDefaults'
import { useI18n } from '../i18n/I18nProvider'

export type PreflightView =
  | { kind: 'checking' }
  | { kind: 'ok'; repo: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'failed'; message: string }
  /** A Host from before this app, which does not know the check (it outlives an app update; final review M7). */
  | { kind: 'outdated' }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The Host's answer to `github-preflight`: the repository, the reason the folder cannot carry it, or why it could not be
 *  asked (a Host not running, a Runtime away). */
export function preflightOf(reply: { status: number; body: unknown }): PreflightView {
  const body = isObject(reply.body) ? reply.body : {}
  if (reply.status === 200 && body.ok === true && typeof body.repo === 'string') return { kind: 'ok', repo: body.repo }
  if (reply.status === 200 && body.ok === false && typeof body.reason === 'string') return { kind: 'refused', reason: body.reason }
  if (reply.status === 501) return { kind: 'outdated' }
  return { kind: 'failed', message: typeof body.error === 'string' ? body.error : `the Host answered ${reply.status}` }
}

/** The check for the folder now (Review Focus 5): an answer held for another folder, or none yet, reads as still
 *  checking; with the lifecycle off there is none. */
export function currentPreflight(key: string | null, held: { key: string; view: PreflightView } | null): PreflightView | null {
  if (key === null) return null
  return held?.key === key ? held.view : { kind: 'checking' }
}

/** What is kept of an answer while the lifecycle is off: nothing, so turning it on again asks afresh rather than show
 *  the answer from before (final review M1). */
export function heldWhile(key: string | null, held: { key: string; view: PreflightView } | null): { key: string; view: PreflightView } | null {
  return key === null ? null : held
}

/** Create waits while the lifecycle is on and the folder is not known to carry it: the Host would refuse the Job with
 *  the reason the field already shows. */
export const lifecycleBlocksCreate = (checked: boolean, preflight: PreflightView | null): boolean => checked && preflight?.kind !== 'ok'

/** Asks for the folder's check while the lifecycle is on, and keeps only the answer for the folder it was asked about.
 *  `ask` is read through a ref: a door made again on each render must not ask again. */
export function useLifecyclePreflight(ask: (cwd: string) => Promise<{ status: number; body: unknown }>, checked: boolean, cwd: string | null): PreflightView | null {
  const askRef = useRef(ask)
  askRef.current = ask
  const [held, setHeld] = useState<{ key: string; view: PreflightView } | null>(null)
  const key = checked && cwd !== null ? cwd : null
  // Forgotten in the render that turns it off, before anything is drawn (React's state from the previous render)
  const kept = heldWhile(key, held)
  if (kept !== held) setHeld(kept)
  useEffect(() => {
    if (key === null) return
    let live = true
    askRef.current(key).then(
      (r) => live && setHeld({ key, view: preflightOf(r) }),
      (e: unknown) => live && setHeld({ key, view: { kind: 'failed', message: e instanceof Error ? e.message : String(e) } })
    )
    return () => {
      live = false
    }
  }, [key])
  return currentPreflight(key, kept)
}

export function LifecycleField(p: {
  checked: boolean
  onChange(on: boolean): void
  preflight: PreflightView | null
  /** This computer's Settings › GitHub, `'runtime'` for a paired Runtime's (which makes the Job with its own), or null
   *  while they load. */
  defaults: GitHubLifecycleDefaults | 'runtime' | null
}): React.JSX.Element {
  const { t } = useI18n()
  const pre = p.preflight
  return (
    <div className="field">
      <label className="check-small">
        <input type="checkbox" checked={p.checked} onChange={(e) => p.onChange(e.target.checked)} />
        {t('jobs.new.github')}
      </label>
      <p className="modal-hint">{t('jobs.new.githubHint')}</p>
      {p.checked && pre !== null && (
        <p className={pre.kind === 'checking' || pre.kind === 'ok' ? 'modal-hint' : 'warn-text'}>
          {pre.kind === 'checking'
            ? t('jobs.new.githubChecking')
            : pre.kind === 'ok'
              ? t('jobs.new.githubOk', { repo: pre.repo })
              : pre.kind === 'refused'
                ? t('jobs.new.githubRefused', { reason: pre.reason })
                : pre.kind === 'outdated'
                  ? t('jobs.new.githubHostOld')
                  : t('jobs.new.githubFailed', { message: pre.message })}
        </p>
      )}
      {p.checked && p.defaults !== null && (
        <p className="modal-hint">
          {p.defaults === 'runtime'
            ? t('jobs.new.githubDefaultsRuntime')
            : p.defaults.autoRerunInfrastructureFailures
              ? t('jobs.new.githubDefaults', { reruns: p.defaults.maxInfrastructureReruns, minutes: p.defaults.ciWaitMinutes })
              : t('jobs.new.githubDefaultsNoRerun', { minutes: p.defaults.ciWaitMinutes })}
        </p>
      )}
    </div>
  )
}

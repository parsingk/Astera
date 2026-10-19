import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Account, SourcesCallAnswer } from '../../../core/types'
import type { MessageKey, MessageParams } from '../../../core/i18n'
import { DEFAULT_BLOCKING_SEVERITY } from '../../../core/orchestration/convergence'
import { FAILURE_LIMIT, MAX_REVIEW_ROUNDS } from '../../../core/orchestration/types'
import { useI18n } from '../i18n/I18nProvider'
import { AccountSelect } from './AccountSelect'
import { failureLine } from './pluginsText'
import { backdropProps } from '../lib/backdrop'
import { createPause } from '../lib/pausedSearch'
import { localDoor } from '../lib/orchDoor'
import { LifecycleField, lifecycleBlocksCreate, useLifecyclePreflight, type PreflightView } from './LifecycleField'
import type { GitHubLifecycleDefaults } from '../../../core/github/lifecycleDefaults'

// The Jobs view's "+ 소스에서" (plugin Phase 4 J20, §3): pick a source, find a ticket, read it, and make a Job from it
// in one step. The Host does the work (window.api.sources, main's sources route); this window keeps what the person
// picked and what came back. The rules it keeps are pure functions below, and what it shows is SourceJobView, so the
// node-only renderer tests cover both; SourceJobModal is the state and the calls between them.

type T = (key: MessageKey, params?: MessageParams) => string

/** A source as `sources-list` answers it. */
export interface SourceRow {
  id: string
  displayName: string
  ready: boolean
  reason?: string
  needsProject: boolean
}

/** An item as `sources-items` answers it, and as `sources-show` answers it read whole. */
export interface ItemRow {
  id: string
  title: string
  status?: string
  url?: string
  summary?: string
  selectable?: boolean
  reason?: string
  jobs?: string[]
}
export interface ItemDetail extends ItemRow {
  body?: string
  fields?: Record<string, string>
  /** The Host cut it to its limits (J7), and says so. */
  cut?: boolean
}

/** The list under the search: the request it shows (`seq`), its items, the next page's cursor, whether the Host cut
 *  it, and the error that takes its place. */
export interface ListState {
  seq: number
  items: ItemRow[]
  nextCursor?: string
  cut?: boolean
  error?: string
  loading: boolean
}
export const EMPTY_LIST: ListState = { seq: 0, items: [], loading: false }

/** The picked item and what the window says about it: its detail, or the read under way or failed, and why a make
 *  failed. One value, so a source change and a new pick reset it in one place (4c final review M2, M3). */
export interface PaneState {
  picked?: string
  detail: ItemDetail | null
  detailLoading: boolean
  detailError?: string
  error?: string
}
export const EMPTY_PANE: PaneState = { detail: null, detailLoading: false }

/** How long the search waits after the last key (J12): GitHub's search is rate limited. */
export const SEARCH_PAUSE_MS = 300

/** Why a source does not run, as the app says it: a plugin missing a setting points at Settings › Plugins rather than
 *  at the CLI the Host's sentence names (4c final review M5). */
function sourceReason(reason: string, t: T): string {
  const keys = /needs settings: ([^;]+); set them with astera plugins configure\b/.exec(reason)?.[1]
  return keys !== undefined ? t('jobs.source.needsSettings', { keys }) : reason
}

/** A source as an option of the dropdown: one that is not ready is greyed with its reason, and cannot be picked
 *  (§3.1), so it is never asked for items (Review Focus 4). */
export function sourceChoice(s: SourceRow, t: T): { value: string; label: string; disabled: boolean } {
  if (s.ready) return { value: s.id, label: s.displayName, disabled: false }
  return { value: s.id, label: `${s.displayName} (${s.reason !== undefined ? sourceReason(s.reason, t) : t('jobs.source.notReady')})`, disabled: true }
}

/** A read that came back with nothing, as the app says it: no Host, a deadline and a lost answer in the app's words,
 *  as Settings › Plugins says them, the Host's own sentence otherwise (4c final review M4). */
export function sourceFailure(answer: Extract<SourcesCallAnswer, { ok: false }>, t: T): string {
  return failureLine(answer, t, { read: true })
}

/** The list once the answer to request `seq` came back. An answer to an older request is dropped, so a slow first
 *  search never replaces a newer one (Review Focus 1); `append` adds a page ("More") to what is shown, keeping a cut
 *  already said and leaving out an item a page repeated (4c final review M14). */
export function listAfter(state: ListState, seq: number, answer: SourcesCallAnswer, append: boolean, t?: T): ListState {
  if (seq !== state.seq) return state
  if (!answer.ok) {
    const { error: _old, ...rest } = state
    return { ...rest, loading: false, error: t !== undefined ? sourceFailure(answer, t) : answer.message }
  }
  const page = Array.isArray(answer.body.items) ? (answer.body.items as ItemRow[]) : []
  const shown = new Set(append ? state.items.map((i) => i.id) : [])
  const items = append ? [...state.items, ...page.filter((i) => !shown.has(i.id))] : page
  const next = typeof answer.body.nextCursor === 'string' ? answer.body.nextCursor : undefined
  const cut = answer.body.cut === true || (append && state.cut === true)
  return { seq, items, ...(next !== undefined ? { nextCursor: next } : {}), ...(cut ? { cut: true } : {}), loading: false }
}

/** The pane once the source changed: nothing picked, nothing loading, no error left from before (M2, M3). */
export const paneOnSource = (): PaneState => EMPTY_PANE
/** The pane once `id` is picked: its read under way, and a make's error from before gone. */
export const paneOnPick = (id: string): PaneState => ({ picked: id, detail: null, detailLoading: true })
/** The pane once the read of `id` came back: dropped when another item was picked since. */
export function paneOnDetail(pane: PaneState, id: string, answer: SourcesCallAnswer, t: T): PaneState {
  if (pane.picked !== id) return pane
  if (answer.ok) return { picked: id, detail: answer.body as unknown as ItemDetail, detailLoading: false }
  return { picked: id, detail: null, detailLoading: false, detailError: sourceFailure(answer, t) }
}

/** Whether "Make the Job" may be pressed: an item that can be picked, read whole; a coordinator account (§3.4); not
 *  while a make is out, and never again after one whose answer was lost (Review Focus 3). */
/** `held`: the GitHub lifecycle is on and the folder is not known to carry it (G7a, `lifecycleBlocksCreate`). */
export function canMake(a: { item: ItemRow | null; account: string; busy: boolean; locked: boolean; held?: boolean }): boolean {
  return a.item !== null && a.item.selectable !== false && a.account !== '' && !a.busy && !a.locked && a.held !== true
}

/** What a make's answer means: the Job made, or why not. A lost answer or a deadline may have made the Job, so the
 *  window locks rather than offer a second (Review Focus 3). */
export function madeOutcome(answer: SourcesCallAnswer): { made: string } | { error: string; lock: boolean } {
  if (answer.ok) return { made: String(answer.body.id) }
  return { error: answer.message, lock: answer.code === 'HOST_LOST' || answer.code === 'TIMEOUT' }
}

/** The Job "Job exists" opens: the newest made from the item, the likelier one wanted (4c final review M18). */
export const jobToOpen = (jobs: readonly string[]): string => jobs[jobs.length - 1]

export interface SourceJobViewProps {
  /** null while the sources load, or when they could not be read (`sourcesError`). */
  sources: SourceRow[] | null
  sourcesError?: string
  source: string
  query: string
  list: ListState
  picked?: string
  detail: ItemDetail | null
  detailLoading: boolean
  detailError?: string
  /** null while the accounts load. */
  accounts: Account[] | null
  account: string
  convergence: boolean
  /** The GitHub lifecycle (G7a): off by default; on, convergence is on with it. */
  github: boolean
  githubPreflight: PreflightView | null
  githubDefaults: GitHubLifecycleDefaults | null
  busy: boolean
  locked: boolean
  error?: string
  onSource(id: string): void
  onRetrySources(): void
  onQuery(q: string): void
  onRetry(): void
  onMore(): void
  onPick(id: string): void
  onOpenJob(jobId: string): void
  onOpenLink(url: string): void
  onAccount(id: string): void
  onConvergence(on: boolean): void
  onGithub(on: boolean): void
  onMake(): void
  onClose(): void
}

export function SourceJobView(p: SourceJobViewProps): React.JSX.Element {
  const { t } = useI18n()
  const makeable = canMake({ item: p.detail, account: p.account, busy: p.busy, locked: p.locked, held: lifecycleBlocksCreate(p.github, p.githubPreflight) })
  return (
    <div className="modal-backdrop" {...backdropProps(() => !p.busy && p.onClose())}>
      <div className="modal source-job" onClick={(e) => e.stopPropagation()}>
        <h2>{t('jobs.source.title')}</h2>
        <p className="modal-hint">{t('jobs.new.gitRequired')}</p>
        {/* A native select, not the app's Select: a source that is not ready is a greyed option, which Select has no
            way to draw (§3.1). `field` gives the search the app's input look. */}
        <div className="field source-pick">
          {p.sources === null ? (
            p.sourcesError !== undefined ? (
              <div className="source-error">
                <p className="warn-text">{p.sourcesError}</p>
                <button onClick={p.onRetrySources}>{t('jobs.source.retry')}</button>
              </div>
            ) : (
              <p className="modal-hint">{t('jobs.source.sourcesLoading')}</p>
            )
          ) : (
            <select value={p.source} onChange={(e) => p.onSource(e.target.value)} aria-label={t('jobs.source.source')} autoFocus>
              <option value="">{t('jobs.source.sourcePick')}</option>
              {p.sources.map((s) => {
                const c = sourceChoice(s, t)
                return (
                  <option key={c.value} value={c.value} disabled={c.disabled}>
                    {c.label}
                  </option>
                )
              })}
            </select>
          )}
          {p.source !== '' && (
            <input
              type="text"
              value={p.query}
              placeholder={t('jobs.source.searchPlaceholder')}
              aria-label={t('jobs.source.search')}
              onChange={(e) => p.onQuery(e.target.value)}
              autoFocus
            />
          )}
        </div>
        {p.source !== '' && (
          <div className="source-columns">
            <div className="source-items">
              {p.list.error !== undefined ? (
                // A source's error takes the list's place, with a way to ask again (§3)
                <div className="source-error">
                  <p className="warn-text">{p.list.error}</p>
                  <button onClick={p.onRetry}>{t('jobs.source.retry')}</button>
                </div>
              ) : p.list.items.length === 0 ? (
                <p className="modal-hint">{p.list.loading ? t('jobs.source.loading') : t('jobs.source.empty')}</p>
              ) : (
                <ul>
                  {p.list.items.map((i) => {
                    const cannot = i.selectable === false
                    return (
                      // A row is picked by the keyboard too (4c final review M9)
                      <li
                        key={i.id}
                        className={`source-item${cannot ? ' disabled' : ''}${p.picked === i.id ? ' picked' : ''}`}
                        role="button"
                        tabIndex={0}
                        title={cannot ? i.reason : i.title}
                        onClick={() => p.onPick(i.id)}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter' && e.key !== ' ') return
                          e.preventDefault()
                          p.onPick(i.id)
                        }}
                      >
                        <span className="source-id">{i.id}</span>
                        <span className="source-title">{i.title}</span>
                        {i.status !== undefined && <span className="source-status">{i.status}</span>}
                        {(i.jobs?.length ?? 0) > 0 && (
                          <button
                            type="button"
                            className="source-exists"
                            onClick={(e) => {
                              e.stopPropagation()
                              p.onOpenJob(jobToOpen(i.jobs!))
                            }}
                            onKeyDown={(e) => e.stopPropagation()}
                          >
                            {t('jobs.source.exists')}
                          </button>
                        )}
                        {cannot && <span className="source-reason">{t('jobs.source.cannotPick', { reason: i.reason ?? '' })}</span>}
                      </li>
                    )
                  })}
                </ul>
              )}
              {p.list.cut === true && <p className="modal-hint">{t('jobs.source.cut')}</p>}
              {p.list.nextCursor !== undefined && p.list.error === undefined && (
                <button disabled={p.list.loading} onClick={p.onMore}>
                  {t('jobs.source.more')}
                </button>
              )}
            </div>
            <div className="source-detail">
              {p.detail !== null ? (
                <>
                  <h3>
                    {p.detail.id} {p.detail.title}
                  </h3>
                  {/* Why it cannot be picked, a cut and the way to the ticket come before a body of up to 20,000
                      characters, so they are in view (4c final review M7, M8) */}
                  {p.detail.selectable === false && <p className="warn-text">{t('jobs.source.cannotPick', { reason: p.detail.reason ?? '' })}</p>}
                  {p.detail.cut === true && <p className="modal-hint">{t('jobs.source.cut')}</p>}
                  {p.detail.fields !== undefined && Object.keys(p.detail.fields).length > 0 && (
                    <table className="source-fields">
                      <tbody>
                        {Object.entries(p.detail.fields).map(([k, v]) => (
                          <tr key={k}>
                            <th>{k}</th>
                            <td>{v}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {p.detail.url !== undefined && (
                    <button type="button" onClick={() => p.onOpenLink(p.detail!.url!)}>
                      {t('jobs.source.openLink')}
                    </button>
                  )}
                  <p className="modal-hint">{t('jobs.source.dataHint')}</p>
                  {/* Someone else wrote it: shown as the text it is, never as Markdown or HTML (§3.3) */}
                  <pre className="source-body">{p.detail.body ?? ''}</pre>
                </>
              ) : (
                <p className="modal-hint">{p.detailError ?? (p.detailLoading ? t('jobs.source.loading') : t('jobs.source.pickItem'))}</p>
              )}
            </div>
          </div>
        )}
        {p.accounts !== null && (
          <div className="field">
            <label>{t('jobs.new.coordinator')}</label>
            <AccountSelect accounts={p.accounts} value={p.account} onChange={p.onAccount} allLabel={t('jobs.new.coordinatorPick')} />
            <p className="modal-hint">{t('jobs.new.coordinatorHint')}</p>
            {p.accounts.length === 0 && <p className="warn-text">{t('jobs.task.accountEmpty')}</p>}
          </div>
        )}
        {/* As the new-Job window has them (plan P4, 4c final review M16) */}
        <div className="field">
          <label className="check-small">
            {/* On with the GitHub lifecycle, which repairs through it */}
            <input type="checkbox" checked={p.convergence || p.github} disabled={p.github} onChange={(e) => p.onConvergence(e.target.checked)} />
            {t('jobs.new.convergence')}
          </label>
          <p className="modal-hint">{t('jobs.new.convergenceHint')}</p>
          <p className="modal-hint">
            {t('jobs.new.convergenceDefaults', { fix: FAILURE_LIMIT, review: MAX_REVIEW_ROUNDS, severity: DEFAULT_BLOCKING_SEVERITY })}
            {' — '}
            {t('jobs.new.convergenceCliOnly')}
          </p>
        </div>
        {/* G7a (design §8): issue → Job can carry the Job through GitHub, off by default. Offered for every source: the
            lifecycle is about where the code goes, not where the work came from. */}
        <LifecycleField checked={p.github} onChange={p.onGithub} preflight={p.githubPreflight} defaults={p.githubDefaults} />
        {p.error !== undefined && <p className="warn">{p.error}</p>}
        <div className="row right">
          <button onClick={p.onClose} disabled={p.busy}>
            {t('common.cancel')}
          </button>
          <button className="primary" disabled={!makeable} onClick={p.onMake}>
            {t('jobs.source.make')}
          </button>
        </div>
      </div>
    </div>
  )
}

const failure = (e: unknown): SourcesCallAnswer => ({ ok: false, code: 'FAILED', message: e instanceof Error ? e.message : String(e) })

export function SourceJobModal({
  projectPath,
  accounts,
  onClose,
  onCreated,
  onOpenJob
}: {
  /** The project the Job is made in: the one the Jobs view showed when the window opened. */
  projectPath: string
  accounts: Account[] | null
  onClose: () => void
  /** The Job made: the caller opens it (plan P5). */
  onCreated: (jobId: string) => void
  /** "Job exists" on an item (J16): the caller opens that Job, and keeps the window when it cannot. */
  onOpenJob: (jobId: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [sources, setSources] = useState<SourceRow[] | null>(null)
  const [sourcesError, setSourcesError] = useState<string>()
  const [source, setSource] = useState('')
  const [query, setQuery] = useState('')
  const [list, setList] = useState<ListState>(EMPTY_LIST)
  const [pane, setPane] = useState<PaneState>(EMPTY_PANE)
  const [account, setAccount] = useState('')
  const [convergence, setConvergence] = useState(false)
  const [github, setGithub] = useState(false)
  const [githubDefaults, setGithubDefaults] = useState<GitHubLifecycleDefaults | null>(null)
  // The folder the Job is made in, asked of the Host before the Job is (G7a)
  const githubPreflight = useLifecyclePreflight((cwd) => localDoor(window.api, projectPath).command('github-preflight', { cwd }), github, projectPath)
  useEffect(() => {
    if (github) void window.api.settings.getGithubLifecycle().then((d) => live.current && setGithubDefaults(d), () => {})
  }, [github])
  const [busy, setBusy] = useState(false)
  const [locked, setLocked] = useState(false)
  /** The latest list request: an answer to an older one is dropped (Review Focus 1). */
  const listSeq = useRef(0)
  /** A make under way, read synchronously: two quick presses come before React draws the button disabled. */
  const making = useRef(false)
  /** The source and the text the paused search asks: the ones picked when it fires, not when the key was pressed. */
  const sourceRef = useRef('')
  const queryRef = useRef('')
  /** Whether the window is still open, for an answer that comes back after it closed. Set again on every mount: React's
   *  StrictMode mounts, unmounts and mounts again in development, and a flag only ever cleared stayed false there, so
   *  every answer was dropped and the sources never left "loading" (found on the hidden desktop in the 4c fix pass). */
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const loadSources = useCallback(async (): Promise<void> => {
    setSourcesError(undefined)
    setSources(null)
    let a: SourcesCallAnswer
    try {
      a = await window.api.sources.list()
    } catch (e) {
      a = failure(e)
    }
    if (!live.current) return
    if (!a.ok) setSourcesError(sourceFailure(a, t))
    else setSources(Array.isArray(a.body.sources) ? (a.body.sources as SourceRow[]) : [])
  }, [t])
  useEffect(() => {
    void loadSources()
  }, [loadSources])

  const search = useCallback(
    async (src: string, q: string, cursor?: string): Promise<void> => {
      if (src === '') return
      const mine = ++listSeq.current
      setList((s) => (cursor !== undefined ? { ...s, seq: mine, loading: true } : { seq: mine, items: [], loading: true }))
      let answer: SourcesCallAnswer
      try {
        answer = await window.api.sources.items({ source: src, projectPath, ...(q !== '' ? { query: q } : {}), ...(cursor !== undefined ? { cursor } : {}) })
      } catch (e) {
        answer = failure(e)
      }
      if (!live.current) return
      setList((s) => listAfter(s, mine, answer, cursor !== undefined, t))
      // A source the Host no longer has (a plugin removed while the window was open): the list of sources is read again
      if (!answer.ok && answer.code === 'NOT_FOUND' && mine === listSeq.current) void loadSources()
    },
    [projectPath, t, loadSources]
  )
  const pause = useMemo(() => createPause(SEARCH_PAUSE_MS, (q) => void search(sourceRef.current, q)), [search])
  useEffect(() => () => pause.cancel(), [pause])

  const pick = async (id: string): Promise<void> => {
    setPane(paneOnPick(id))
    let answer: SourcesCallAnswer
    try {
      answer = await window.api.sources.show({ source: sourceRef.current, item: id, projectPath })
    } catch (e) {
      answer = failure(e)
    }
    if (live.current) setPane((p) => paneOnDetail(p, id, answer, t))
  }

  const make = async (): Promise<void> => {
    const item = pane.detail
    if (making.current || !canMake({ item, account, busy, locked, held: lifecycleBlocksCreate(github, githubPreflight) }) || item === null) return
    making.current = true
    setBusy(true)
    setPane((p) => ({ ...p, error: undefined }))
    try {
      const outcome = madeOutcome(
        await window.api.sources.create({
          source: sourceRef.current,
          item: item.id,
          projectPath,
          coordinatorAccount: account,
          ...(convergence || github ? { convergence: true } : {}),
          ...(github ? { githubLifecycle: true } : {})
        })
      )
      if ('made' in outcome) {
        onCreated(outcome.made)
        return
      }
      if (!live.current) return
      setPane((p) => ({ ...p, error: outcome.lock ? t('jobs.source.lost') : outcome.error }))
      if (outcome.lock) setLocked(true)
    } catch {
      // The IPC itself failed: whether the Job was made is not known, so no second one is offered
      if (!live.current) return
      setPane((p) => ({ ...p, error: t('jobs.source.lost') }))
      setLocked(true)
    } finally {
      making.current = false
      if (live.current) setBusy(false)
    }
  }

  return (
    <SourceJobView
      sources={sources}
      sourcesError={sourcesError}
      source={source}
      query={query}
      list={list}
      picked={pane.picked}
      detail={pane.detail}
      detailLoading={pane.detailLoading}
      detailError={pane.detailError}
      accounts={accounts}
      account={account}
      convergence={convergence}
      busy={busy}
      locked={locked}
      error={pane.error}
      onSource={(id) => {
        pause.cancel()
        sourceRef.current = id
        queryRef.current = ''
        setSource(id)
        setQuery('')
        setPane(paneOnSource())
        if (id === '') {
          ++listSeq.current
          setList(EMPTY_LIST)
        } else void search(id, '')
      }}
      onRetrySources={() => void loadSources()}
      onQuery={(q) => {
        queryRef.current = q
        setQuery(q)
        pause.type(q)
      }}
      onRetry={() => void search(sourceRef.current, queryRef.current)}
      onMore={() => list.nextCursor !== undefined && void search(sourceRef.current, queryRef.current, list.nextCursor)}
      onPick={(id) => void pick(id)}
      onOpenJob={onOpenJob}
      onOpenLink={(url) => void window.api.system.openExternal(url)}
      onAccount={setAccount}
      onConvergence={setConvergence}
      github={github}
      githubPreflight={githubPreflight}
      githubDefaults={githubDefaults}
      onGithub={setGithub}
      onMake={() => void make()}
      onClose={onClose}
    />
  )
}

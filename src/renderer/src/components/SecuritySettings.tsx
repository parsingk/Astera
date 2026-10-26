import { useEffect, useId, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { AuditQuery, PluginsCallAnswer } from '../../../core/types'
import type { AuditMode, AuditPolicy, AuditRule, CoverageRow } from '../../../core/audit/types'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'
import { confirmModal } from '../lib/confirm'
import { useAgentProfiles } from '../lib/agentProfiles'
import { Select } from './Select'
import { profileNameOf } from './agentProfilesText'
import {
  AUDIT_ACTIONS,
  AUDIT_LOGS_TITLE,
  COVERAGE_CLASSES,
  DECISIONS,
  MODES,
  PERIODS,
  POLICIES_TITLE,
  actionPhrase,
  appendPage,
  auditQuery,
  auditStateLine,
  coverageCellText,
  coverageClassLabel,
  coverageLine,
  coverageRowLabel,
  decidingRule,
  decisionLabel,
  effectLabel,
  filterChoices,
  FOCUS_VALUE,
  focusedFilters,
  jobFilterChange,
  nextPageQuery,
  pageOf,
  recordTime,
  rowTime,
  ruleActionChoices,
  scopeLabel,
  securityFailure,
  sessionLabel,
  summaryOf,
  type AuditCounts,
  type AuditCursor,
  type AuditFilters,
  type AuditFocus,
  type AuditRow,
  type FilterChoices,
  type Period
} from './securityText'

type Failure = Extract<PluginsCallAnswer, { ok: false }>
type Changes = { effect?: AuditRule['effect']; action?: string; scope?: AuditRule['scope'] | null }

/** A call that threw (main gone, an IPC error) answers like one the Host refused, so every path says why. */
const failed = (e: unknown): PluginsCallAnswer => ({ ok: false, code: 'FAILED', message: e instanceof Error ? e.message : String(e) })
const arr = <V,>(v: unknown): V[] => (Array.isArray(v) ? (v as V[]) : [])
const policyIn = (body: Record<string, unknown>): AuditPolicy | null => {
  const p = body.policy as AuditPolicy | undefined
  return p && Array.isArray(p.rules) ? p : null
}
const MODE_ORDER: AuditMode[] = ['compatibility', 'observe']
const EFFECT_ORDER: AuditRule['effect'][] = ['allow', 'deny']
const SCOPE_ORDER = ['anywhere', 'inside-project', 'outside-project'] as const
const PERIOD_ORDER: Period[] = ['today', 'week', 'month']
/** Rows a page of Audit Logs reads at a time. */
const PAGE = 100

/** Settings › Security & Access (observe mode design §11): Policies, the observe switch, what observe can see and the
 *  one rule set, and Audit Logs, the calls observed sessions made judged by those rules as they are now. The Host owns
 *  the rules and the records and answers every change with the rules as they are after it; nothing here decides a call.
 *  `focus`: the Run (or a Job row with no Run of its own) Run detail opened this for, whose calls only Audit Logs shows
 *  until the filter is cleared; clearing it keeps the other filters and the period. */
export function SecuritySettings({
  focus,
  onClearFocus,
  sessionTitle,
  runName
}: {
  focus?: AuditFocus
  onClearFocus: () => void
  /** A session's tab title while this app has the tab. */
  sessionTitle: (sessionId: string) => string | undefined
  /** A Run's Job name while this project's Jobs list has it. */
  runName: (runId: string) => string | undefined
}): React.JSX.Element {
  const { t } = useI18n()
  const [policy, setPolicy] = useState<AuditPolicy | null>(null)
  const [coverage, setCoverage] = useState<CoverageRow[]>([])
  const [failure, setFailure] = useState<Failure | null>(null)
  const [busy, setBusy] = useState(false)
  /** Counts the rule changes: Audit Logs reads again after each, since the rules decide every row it shows. */
  const [changes, setChanges] = useState(0)
  const radioGroup = useId()

  const load = async (): Promise<void> => {
    const r = await window.api.audit.policies().catch(failed)
    if (!r.ok) {
      setFailure(r)
      // A damaged file holds no rules to show; the Host away for a moment leaves the last ones read on screen
      if (r.reason === 'damaged') setPolicy(null)
      return
    }
    setFailure(null)
    setPolicy(policyIn(r.body))
    setCoverage(arr<CoverageRow>(r.body.coverage))
  }
  useEffect(() => {
    void load()
  }, [])

  /** Runs one change, shows the rules the Host answered with or says why it did not happen, and reads the rules again
   *  either way, as Agent profiles does: a failed change may have found the file damaged (its repair is then offered)
   *  or changed from the CLI meanwhile, and a repair brings back what observe can see. */
  const change = async (work: () => Promise<PluginsCallAnswer>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const r = await work().catch(failed)
      if (!r.ok) return void toast.error(securityFailure(r, t).line)
      const p = policyIn(r.body)
      if (p !== null) setPolicy(p)
      setChanges((n) => n + 1)
    } finally {
      setBusy(false)
      void load()
    }
  }

  /** Starting over is also the repair of a damaged rules file (the Host keeps the damaged copy beside it). */
  const reset = async (): Promise<void> => {
    const ok = await confirmModal({
      title: t('settings.security.reset.title'),
      body: t('settings.security.reset.body'),
      confirmLabel: t('settings.security.reset')
    })
    if (ok) await change(() => window.api.audit.resetRules())
  }

  const shownFailure = failure !== null ? securityFailure(failure, t) : null
  return (
    <div className="settings-stack">
      <p className="settings-hint">{t('settings.security.hint')}</p>
      <section className="security-section" aria-busy={busy || (policy === null && failure === null)}>
        <h3 className="security-title">{POLICIES_TITLE}</h3>
        {shownFailure !== null && (
          <div className="settings-group">
            <p className="settings-hint is-warning">{shownFailure.line}</p>
            {shownFailure.repair && (
              <button className="settings-gen-refresh" disabled={busy} onClick={() => void reset()}>
                {t('settings.security.reset')}
              </button>
            )}
          </div>
        )}
        {policy !== null && (
          <>
            <div className="settings-group">
              <div className="settings-row">
                <span>{t('settings.security.mode.label')}</span>
                <div className="security-choices" role="radiogroup" aria-label={t('settings.security.mode.label')}>
                  {MODE_ORDER.map((m) => (
                    <label key={m} className="check-small">
                      <input type="radio" name={radioGroup} checked={policy.mode === m} disabled={busy} onChange={() => void change(() => window.api.audit.setMode(m))} />
                      <span>{t(MODES[m])}</span>
                    </label>
                  ))}
                </div>
              </div>
              <p className="settings-hint">{t('settings.security.mode.hint')}</p>
            </div>
            {coverage.length > 0 && (
              <div className="settings-group">
                <div className="settings-field-label">{t('settings.security.coverage.title')}</div>
                <div className="security-table-wrap">
                  <table className="security-table">
                    <thead>
                      <tr>
                        <th />
                        {COVERAGE_CLASSES.map((c) => (
                          <th key={c} scope="col">
                            {coverageClassLabel(c, t)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {coverage.map((r) => (
                        <tr key={`${r.provider}-${r.kind}`}>
                          <th scope="row">{coverageRowLabel(r, t)}</th>
                          {COVERAGE_CLASSES.map((c) => (
                            <td key={c} className={`is-${r.classes?.[c]?.level ?? 'none'}`}>
                              {coverageCellText(r.classes?.[c], t)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <div className="settings-group">
              <div className="settings-field-label">{t('settings.security.rules.title')}</div>
              <p className="settings-hint">{t('settings.security.rules.hint')}</p>
              {policy.rules.length === 0 ? (
                <p className="settings-hint">{t('settings.security.rules.none')}</p>
              ) : (
                <ol className="ext-list is-uncapped security-rules">
                  {policy.rules.map((r, i) => (
                    <li key={r.id} className="ext-row security-rule">
                      <span className="detail-check-no">{i + 1}</span>
                      <RuleFields rule={r} place={i + 1} busy={busy} onChange={(c) => void change(() => window.api.audit.editRule(r.id, c))} />
                      <button
                        type="button"
                        title={t('settings.security.rules.moveUp')}
                        aria-label={`${i + 1}: ${t('settings.security.rules.moveUp')}`}
                        disabled={busy || i === 0}
                        onClick={() => void change(() => window.api.audit.moveRule(r.id, i - 1))}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        title={t('settings.security.rules.moveDown')}
                        aria-label={`${i + 1}: ${t('settings.security.rules.moveDown')}`}
                        disabled={busy || i === policy.rules.length - 1}
                        onClick={() => void change(() => window.api.audit.moveRule(r.id, i + 1))}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        title={t('settings.security.rules.remove')}
                        aria-label={`${i + 1}: ${t('settings.security.rules.remove')}`}
                        disabled={busy}
                        onClick={() => void change(() => window.api.audit.removeRule(r.id))}
                      >
                        <X size={12} />
                      </button>
                    </li>
                  ))}
                </ol>
              )}
              <NewRule busy={busy} onAdd={(rule) => void change(() => window.api.audit.addRule(rule))} />
              <p className="settings-hint">{t('settings.security.rules.scopeHint')}</p>
            </div>
            <div className="settings-row">
              <span>{t('settings.security.otherwise.label')}</span>
              <Select
                className="settings-gen-select"
                ariaLabel={t('settings.security.otherwise.label')}
                disabled={busy}
                items={EFFECT_ORDER.map((e) => ({ value: e, label: effectLabel(e, t) }))}
                value={policy.otherwise}
                onChange={(v) => void change(() => window.api.audit.setOtherwise(v as AuditPolicy['otherwise']))}
              />
            </div>
            <button className="settings-gen-refresh" disabled={busy} onClick={() => void reset()}>
              {t('settings.security.reset')}
            </button>
          </>
        )}
      </section>
      <section className="security-section">
        <h3 className="security-title">{AUDIT_LOGS_TITLE}</h3>
        <AuditLogs
          mode={policy?.mode ?? null}
          rules={policy?.rules ?? []}
          coverage={coverage}
          changes={changes}
          focus={focus}
          onClearFocus={onClearFocus}
          sessionTitle={sessionTitle}
          runName={runName}
        />
      </section>
    </div>
  )
}

/** A rule's effect, action and place, each changed where it stands (policies-rules-edit). `place`: the rule's number in
 *  the list, which each field's label starts with as the row's buttons' do; none for the rule being added. */
function RuleFields({
  rule,
  place,
  busy,
  onChange
}: {
  rule: Pick<AuditRule, 'effect' | 'action' | 'scope'>
  place?: number
  busy: boolean
  onChange: (c: Changes) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const label = (key: 'settings.security.rules.effect' | 'settings.security.rules.action' | 'settings.security.rules.scope'): string =>
    place === undefined ? t(key) : `${place}: ${t(key)}`
  return (
    <div className="security-rule-fields">
      <Select
        ariaLabel={label('settings.security.rules.effect')}
        disabled={busy}
        items={EFFECT_ORDER.map((e) => ({ value: e, label: effectLabel(e, t) }))}
        value={rule.effect}
        onChange={(v) => onChange({ effect: v as AuditRule['effect'] })}
      />
      <Select
        className="security-rule-action"
        ariaLabel={label('settings.security.rules.action')}
        disabled={busy}
        items={ruleActionChoices(rule.action).map((a) => ({ value: a, label: actionPhrase(a, t) }))}
        value={rule.action}
        onChange={(v) => onChange({ action: v })}
      />
      <Select
        ariaLabel={label('settings.security.rules.scope')}
        disabled={busy}
        items={SCOPE_ORDER.map((s) => ({ value: s, label: scopeLabel(s === 'anywhere' ? undefined : s, t) }))}
        value={rule.scope ?? 'anywhere'}
        // Anywhere clears the place: the Host takes null for that
        onChange={(v) => onChange({ scope: v === 'anywhere' ? null : (v as AuditRule['scope']) })}
      />
    </div>
  )
}

/** The fields of a rule to add at the end of the list, and Add. */
function NewRule({ busy, onAdd }: { busy: boolean; onAdd: (rule: Omit<AuditRule, 'id'>) => void }): React.JSX.Element {
  const { t } = useI18n()
  const [draft, setDraft] = useState<Omit<AuditRule, 'id'>>({ effect: 'deny', action: AUDIT_ACTIONS[0] })
  return (
    <div className="remote-actions security-new-rule">
      <RuleFields
        rule={draft}
        busy={busy}
        onChange={(c) =>
          setDraft((d) => {
            const { scope, ...rest } = { ...d, ...c }
            return scope == null ? rest : { ...rest, scope }
          })
        }
      />
      <button className="settings-gen-refresh" disabled={busy} onClick={() => onAdd(draft)}>
        {t('settings.security.rules.add')}
      </button>
    </div>
  )
}

/** Audit Logs: a period, its counts by decision, the filters, and the rows newest first, a page at a time. */
function AuditLogs({
  mode,
  rules,
  coverage,
  changes,
  focus,
  onClearFocus,
  sessionTitle,
  runName
}: {
  /** Null while the rules could not be read. */
  mode: AuditMode | null
  rules: readonly AuditRule[]
  coverage: readonly CoverageRow[]
  changes: number
  focus?: AuditFocus
  onClearFocus: () => void
  sessionTitle: (sessionId: string) => string | undefined
  runName: (runId: string) => string | undefined
}): React.JSX.Element {
  const { t } = useI18n()
  const profiles = useAgentProfiles()
  // A Run's calls may be older than a week: its view reads the whole retention (today−30 on), the same window Run
  // detail counts them in (summarySince), so the rows here are the ones counted there
  const [period, setPeriod] = useState<Period>(focus !== undefined ? 'month' : 'week')
  const [filters, setFilters] = useState<AuditFilters>({})
  const [rows, setRows] = useState<AuditRow[] | null>(null)
  const [next, setNext] = useState<AuditCursor | null>(null)
  const [counts, setCounts] = useState<AuditCounts | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [choices, setChoices] = useState<FilterChoices>({ sessions: [], jobs: [] })
  const [loadingMore, setLoadingMore] = useState(false)
  /** A read is out: a full day of records takes a moment, and the screen says it is working rather than sit still. */
  const [loading, setLoading] = useState(false)
  /** The query the rows on screen answer, so "more" continues it from the same period start. */
  const query = useRef<AuditQuery>({})
  /** Which read is the latest: a slower answer to an earlier one is dropped. */
  const reading = useRef(0)

  // The focus by its id, so the read follows it and not the object App makes on each render
  const focusRunId = focus !== undefined && 'runId' in focus ? focus.runId : undefined
  const focusJobId = focus !== undefined && 'jobId' in focus ? focus.jobId : undefined
  useEffect(() => {
    const focused: AuditFocus | undefined = focusRunId !== undefined ? { runId: focusRunId, name: '' } : focusJobId !== undefined ? { jobId: focusJobId, name: '' } : undefined
    const q = auditQuery(focusedFilters(filters, focused), period, new Date())
    query.current = q
    const n = ++reading.current
    setLoading(true)
    void Promise.all([window.api.audit.list({ ...q, limit: PAGE }).catch(failed), window.api.audit.summary(q).catch(failed)]).then(([list, sum]) => {
      if (n !== reading.current) return
      setLoading(false)
      if (!list.ok) {
        setFailure(list)
        setRows([])
        setNext(null)
        setCounts(null)
        return
      }
      const page = pageOf(list.body)
      setFailure(null)
      setRows(page.records)
      setNext(page.next)
      setChoices((c) => filterChoices(page.records, c))
      setCounts(sum.ok ? summaryOf(sum.body) : null)
    })
  }, [period, filters, focusRunId, focusJobId, changes])

  const more = async (): Promise<void> => {
    // Not while a new query is being read: its cursor would be paired with the rows of the last one
    const q = nextPageQuery(query.current, next)
    if (q === null || loading || loadingMore) return
    const n = reading.current
    setLoadingMore(true)
    try {
      const r = await window.api.audit.list({ ...q, limit: PAGE }).catch(failed)
      if (n !== reading.current) return
      if (!r.ok) return void toast.error(securityFailure(r, t).line)
      const page = pageOf(r.body)
      setRows((prev) => appendPage(prev ?? [], page.records))
      setNext(page.next)
      setChoices((c) => filterChoices(page.records, c))
    } finally {
      setLoadingMore(false)
    }
  }

  const setFilter = (k: keyof AuditFilters, v: string): void => setFilters((f) => ({ ...f, [k]: v === '' ? undefined : v }))
  const sessionItems = choices.sessions.map((s) => ({ value: s.sessionId, label: sessionLabel(s, sessionTitle(s.sessionId), t) }))
  const jobItems = choices.jobs
    .filter((j) => focus === undefined || ('runId' in focus ? j.runId !== focus.runId : j.id !== focus.jobId))
    .map((j) => ({ value: j.id, label: (j.runId !== undefined ? runName(j.runId) : undefined) ?? j.id.slice(0, 12) }))
  const line = rows === null ? null : auditStateLine({ failure, mode, count: rows.length }, t)

  return (
    <div className="security-audit" aria-busy={loading || loadingMore}>
      <p className="settings-hint">{t('settings.security.audit.hint')}</p>
      <div className="security-filters">
        <Select
          ariaLabel={t('settings.security.period.label')}
          items={PERIOD_ORDER.map((p) => ({ value: p, label: t(PERIODS[p]) }))}
          value={period}
          onChange={(v) => setPeriod(v as Period)}
        />
        <Select
          ariaLabel={t('settings.security.filter.session')}
          items={[{ value: '', label: t('settings.security.filter.allSessions') }, ...sessionItems]}
          value={filters.sessionId ?? ''}
          onChange={(v) => setFilter('sessionId', v)}
        />
        <Select
          ariaLabel={t('settings.security.filter.profile')}
          items={[{ value: '', label: t('settings.security.filter.allProfiles') }, ...profiles.map((p) => ({ value: p.id, label: p.name }))]}
          value={filters.agentProfileId ?? ''}
          onChange={(v) => setFilter('agentProfileId', v)}
        />
        <Select
          ariaLabel={t('settings.security.filter.job')}
          items={[
            { value: '', label: t('settings.security.filter.allJobs') },
            ...(focus !== undefined ? [{ value: FOCUS_VALUE, label: t('settings.security.filter.run', { name: focus.name }) }] : []),
            ...jobItems
          ]}
          value={focus !== undefined ? FOCUS_VALUE : (filters.jobId ?? '')}
          onChange={(v) => {
            const c = jobFilterChange(v, focus !== undefined)
            if (c.clearFocus) onClearFocus()
            if ('jobId' in c) setFilters((f) => ({ ...f, jobId: c.jobId }))
          }}
        />
        <Select
          ariaLabel={t('settings.security.filter.decision')}
          items={[{ value: '', label: t('settings.security.filter.allDecisions') }, ...DECISIONS.map((d) => ({ value: d, label: decisionLabel(d, t) }))]}
          value={filters.decision ?? ''}
          onChange={(v) => setFilter('decision', v)}
        />
        <Select
          ariaLabel={t('settings.security.filter.action')}
          items={[{ value: '', label: t('settings.security.filter.allActions') }, ...AUDIT_ACTIONS.map((a) => ({ value: a, label: actionPhrase(a, t) }))]}
          value={filters.action ?? ''}
          onChange={(v) => setFilter('action', v)}
        />
        {loading && <span className="loading-spinner" aria-hidden="true" />}
      </div>
      {counts !== null && (
        <div className="security-counts">
          <span className="security-decision is-allow">
            {decisionLabel('allow', t)} {counts.allow.toLocaleString()}
          </span>
          <span className="security-decision is-would-deny">
            {decisionLabel('would-deny', t)} {counts.wouldDeny.toLocaleString()}
          </span>
          <span className="security-decision is-unknown">
            {decisionLabel('unknown', t)} {counts.unknown.toLocaleString()}
          </span>
        </div>
      )}
      {counts?.stoppedAtLimit === true && <p className="settings-hint is-warning">{t('settings.security.audit.stoppedAtLimit')}</p>}
      {line !== null && <p className="settings-hint">{line}</p>}
      {rows !== null && rows.length > 0 && (
        <div className="security-table-wrap">
          <table className="security-table security-rows">
            <thead>
              <tr>
                <th scope="col">{t('settings.security.col.time')}</th>
                <th scope="col">{t('settings.security.col.session')}</th>
                <th scope="col">{t('settings.security.col.action')}</th>
                <th scope="col">{t('settings.security.col.target')}</th>
                <th scope="col">{t('settings.security.col.decision')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                // The date heads each day's rows; the full time is on hover
                const when = rowTime(r.at, rows[i - 1]?.at)
                const profile = r.agentProfileId !== undefined ? profileNameOf(profiles, r.agentProfileId) : undefined
                const rule = decidingRule(r, rules, t)
                return (
                  <tr key={r.id}>
                    <td className="security-time" title={recordTime(r.at)}>
                      {when.date !== undefined && <span className="security-date">{when.date}</span>}
                      {when.time}
                    </td>
                    <td className="security-session-cell">
                      {/* With what observe sees of such a session (design §9), on hover */}
                      <span className="security-session" title={coverageLine(coverage, r, t)}>
                        {sessionLabel(r, sessionTitle(r.sessionId), t)}
                      </span>
                      {profile !== undefined && (
                        <span className="security-profile" title={profile}>
                          {profile}
                        </span>
                      )}
                    </td>
                    <td>{actionPhrase(r.action, t)}</td>
                    <td className="security-target" title={r.target}>
                      {r.target}
                    </td>
                    {/* The rule that decided, under the decision: a column of its own left no room at the tab's width */}
                    <td>
                      <span className={`security-decision is-${r.decision}`}>{decisionLabel(r.decision, t)}</span>
                      {rule !== '' && (
                        <span className="security-decided-by" title={`${t('settings.security.col.rule')}: ${rule}`}>
                          {rule}
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {next !== null && (
        <div className="remote-actions">
          <button className="settings-gen-refresh" disabled={loading || loadingMore} onClick={() => void more()}>
            {t('settings.security.audit.more')}
          </button>
          {loadingMore && <span className="loading-spinner" aria-hidden="true" />}
        </div>
      )}
    </div>
  )
}

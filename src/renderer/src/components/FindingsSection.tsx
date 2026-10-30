import { useEffect, useRef, useState } from 'react'
import type { Message } from '../../../core/i18n'
import type { PluginsCallAnswer } from '../../../core/types'
import type { Finding, FindingPlace, FindingsReport } from '../../../core/findings/types'
import { observeNote, unreadLine } from '../../../core/findings/note'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'
import { failureLine } from './extensionsText'
import { GROUP_KEYS, IGNORE_NOTE_MAX, findingGroups, ignoreNote, markTitle, openLabelKey, reportOf, subjectName, wordsOf } from './findingsText'

type Failure = Extract<PluginsCallAnswer, { ok: false }>
/** The finding whose Ignore asks for its note, and the note typed so far. */
type Draft = { key: string; note: string }

/** A call that threw (main gone, an IPC error) answers like one the Host refused, so every path says why. */
const failed = (e: unknown): PluginsCallAnswer => ({ ok: false, code: 'FAILED', message: e instanceof Error ? e.message : String(e) })

/** Settings › Security & Access › Findings, under its heading (lifecycle design §7): what Astera found unused,
 *  duplicated, broken, over-broad, failing or costly, and what the Rules cannot cover, each with the place to act and
 *  Ignore. The Host computes the report and keeps the ignores; this reads it with the ignored ones, which wait under
 *  "Ignored (N)". A button only opens its place (`onOpen`); nothing here acts on a finding. */
export function FindingsSection({ onOpen }: { onOpen: (p: FindingPlace) => void }): React.JSX.Element {
  const { t } = useI18n()
  const [report, setReport] = useState<FindingsReport | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [showIgnored, setShowIgnored] = useState(false)
  /** Which read is the latest: a slower answer to an earlier one is dropped. */
  const reading = useRef(0)

  const load = async (): Promise<void> => {
    const n = ++reading.current
    const r = await window.api.findings.list(true).catch(failed)
    if (n !== reading.current) return
    if (!r.ok) return void setFailure(r)
    const read = reportOf(r.body)
    // An answer that is no report comes from a Host of another version: restarting brings them together
    if (read === null) return void setFailure({ ok: false, code: 'NOT_SUPPORTED', message: 'agent-profiles-audit' })
    setFailure(null)
    setReport(read)
  }
  useEffect(() => {
    void load()
  }, [])

  /** Runs one ignore change, says why when it did not happen, and reads the report again either way. */
  const change = async (work: () => Promise<PluginsCallAnswer>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const r = await work().catch(failed)
      if (r.ok) setDraft(null)
      else if (r.code === 'NOT_FOUND') {
        // The report changed since it was read (the finding resolved, or its subject went): it is read again below
        setDraft(null)
        toast.info(t('findings.ignoreGone'))
      } else toast.error(failureLine(r, t))
    } finally {
      await load()
      setBusy(false)
    }
  }

  return (
    <div className="security-findings" aria-busy={busy || (report === null && failure === null)}>
      {failure !== null && <p className="settings-hint is-warning">{failureLine(failure, t, { read: true })}</p>}
      {report !== null && (
        <FindingsList
          report={report}
          busy={busy}
          draft={draft}
          showIgnored={showIgnored}
          onOpen={onOpen}
          onDraft={setDraft}
          onIgnore={(key, note) => {
            const kept = ignoreNote(note)
            void change(() => window.api.findings.ignore(key, kept))
          }}
          onRestore={(key) => void change(() => window.api.findings.unignore(key))}
          onToggleIgnored={() => setShowIgnored((s) => !s)}
        />
      )}
    </div>
  )
}

/** The report as the section shows it: the Observe note or the sources it could not read, the open findings by group and
 *  subject, each subject's information lines dim under it, and the ignored ones collapsed at the end. Pure, so its
 *  markup is tested without the Host. */
export function FindingsList({
  report,
  busy,
  draft,
  showIgnored,
  onOpen,
  onDraft,
  onIgnore,
  onRestore,
  onToggleIgnored
}: {
  report: FindingsReport
  busy: boolean
  draft: Draft | null
  showIgnored: boolean
  onOpen: (p: FindingPlace) => void
  onDraft: (d: Draft | null) => void
  onIgnore: (key: string, note: string) => void
  onRestore: (key: string) => void
  onToggleIgnored: () => void
}): React.JSX.Element {
  const { t, tm, lang } = useI18n()
  const say = (m: Message, english: string): string => wordsOf(m, english, tm)
  // Not known while the rules file is unread: the unread line names it instead (FindingsReport.observe)
  const note = observeNote(report)
  const unread = unreadLine(lang, report.unread)
  const groups = findingGroups(report)
  const ignored = report.findings.filter((f) => f.ignored)
  const open = report.findings.length - ignored.length
  return (
    <>
      {note !== null && <p className="settings-hint">{tm(note)}</p>}
      {unread !== null && <p className="settings-hint is-warning">{unread}</p>}
      {open === 0 && <p className="settings-hint">{t('findings.none')}</p>}
      {groups.map((g) => (
        <div key={g.kind} className="settings-group">
          <div className="settings-field-label">{t(GROUP_KEYS[g.kind])}</div>
          <div className="ext-list is-uncapped">
            {g.subjects.map((s) => (
              <div key={`${s.subject.kind}:${s.subject.id}`} className="ext-row findings-subject">
                <span className="plugin-name">{subjectName(s.subject, t)}</span>
                {s.findings.map((f) => (
                  <FindingLine key={f.key} finding={f} busy={busy} draft={draft?.key === f.key ? draft : null} onOpen={onOpen} onDraft={onDraft} onIgnore={onIgnore} />
                ))}
                {/* Information, never a finding (§4.12): nothing to open or ignore */}
                {s.info.map((i, n) => (
                  <p key={n} className="settings-hint">
                    {say(i.message, i.reason)}
                  </p>
                ))}
              </div>
            ))}
          </div>
        </div>
      ))}
      {ignored.length > 0 && (
        // Collapsed until opened, as a row of MCP & Skills is (§6)
        <div className="ext-list is-uncapped">
          <div className={`ext-row${showIgnored ? ' is-open' : ''}`}>
            <button type="button" className="ext-row-head" aria-expanded={showIgnored} onClick={onToggleIgnored}>
              <span className="ext-row-chevron" aria-hidden="true">
                {showIgnored ? '▾' : '▸'}
              </span>
              <span>{t('findings.ignoredCount', { count: ignored.length })}</span>
            </button>
            {showIgnored && (
              <div className="ext-row-body">
                {ignored.map((f) => (
                  <div key={f.key} className="findings-line">
                    <span className="plugin-name">{subjectName(f.subject, t)}</span>
                    <span>{say(f.message, f.reason)}</span>
                    {f.note !== undefined && <span className="settings-hint">{t('findings.ignoredNote', { note: f.note })}</span>}
                    <button className="settings-gen-refresh" disabled={busy} onClick={() => onRestore(f.key)}>
                      {t('findings.restore')}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

/** One finding: its reason, what would resolve it (dim), the button to its place and Ignore, which first asks for an
 *  optional note in one line, inline, as Archive asks for its reason. */
function FindingLine({
  finding: f,
  busy,
  draft,
  onOpen,
  onDraft,
  onIgnore
}: {
  finding: Finding
  busy: boolean
  /** This finding's note while its Ignore asks for it. */
  draft: Draft | null
  onOpen: (p: FindingPlace) => void
  onDraft: (d: Draft | null) => void
  onIgnore: (key: string, note: string) => void
}): React.JSX.Element {
  const { t, tm } = useI18n()
  const label = openLabelKey(f.open)
  return (
    <div className="findings-line">
      <span>{wordsOf(f.message, f.reason, tm)}</span>
      <span className="settings-hint">{wordsOf(f.suggestion, f.action, tm)}</span>
      {draft !== null ? (
        <div className="remote-actions">
          <input
            type="text"
            className="settings-gen-input remote-actions-grow"
            aria-label={t('findings.ignoreNote')}
            placeholder={t('findings.ignoreNote')}
            maxLength={IGNORE_NOTE_MAX}
            value={draft.note}
            autoFocus
            onChange={(e) => onDraft({ key: f.key, note: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) onIgnore(f.key, draft.note)
              else if (e.key === 'Escape') onDraft(null)
            }}
          />
          <button className="settings-gen-refresh" disabled={busy} onClick={() => onIgnore(f.key, draft.note)}>
            {t('findings.ignore')}
          </button>
          <button className="settings-gen-refresh" disabled={busy} onClick={() => onDraft(null)}>
            {t('common.cancel')}
          </button>
        </div>
      ) : (
        <div className="remote-actions">
          {label !== null && (
            <button className="settings-gen-refresh" onClick={() => onOpen(f.open)}>
              {t(label)}
            </button>
          )}
          <button className="settings-gen-refresh" disabled={busy} onClick={() => onDraft({ key: f.key, note: '' })}>
            {t('findings.ignore')}
          </button>
        </div>
      )}
    </div>
  )
}

/** Settings › Agent profiles' mark beside a profile with open findings (§7): their count, their reasons as its tooltip,
 *  and a click that opens Security & Access at Findings. */
export function FindingsMark({ findings, onOpen }: { findings: readonly Finding[]; onOpen: () => void }): React.JSX.Element {
  const { t, tm } = useI18n()
  return (
    <button type="button" className="plugin-status findings-mark" title={markTitle(findings, tm)} onClick={onOpen}>
      {t('findings.mark', { count: findings.length })}
    </button>
  )
}

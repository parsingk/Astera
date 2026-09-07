import { useRef, useState } from 'react'
import { AlertTriangle, Plus, X } from 'lucide-react'
import { applyEnvPaste, envRecordOf, envRowIssues, envRowsOf, type EnvRow } from '../../../core/run/envTable'
import { useI18n } from '../i18n/I18nProvider'

/** A configuration's environment variables as a Key · Value table. The rows are this component's
 *  state — while typing, an empty key or a duplicate has to be allowed to exist — and every change is
 *  reported upward as the record the configuration stores (envRecordOf: empty keys dropped, the lower
 *  duplicate wins, no rows → undefined). The rows are reseeded from `env` only when the record the
 *  parent holds stops matching what these rows produce — i.e. when another item was selected — so a
 *  round trip through the parent never reorders or drops a row mid-edit. A paste of KEY=VALUE lines
 *  into a Key cell expands into rows (applyEnvPaste). */
export function EnvTable({
  env,
  onChange
}: {
  env: Record<string, string> | undefined
  onChange: (env: Record<string, string> | undefined) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [rows, setRows] = useState<EnvRow[]>(() => envRowsOf(env))
  const [seededFrom, setSeededFrom] = useState(env)
  // "Derive, don't duplicate": when the parent's record is not what these rows would produce and is
  // not what they were last seeded from, the selection changed underneath — reseed.
  if (env !== seededFrom && JSON.stringify(env ?? null) !== JSON.stringify(envRecordOf(rows) ?? null)) {
    setSeededFrom(env)
    setRows(envRowsOf(env))
  }
  const issues = envRowIssues(rows)
  const tableRef = useRef<HTMLDivElement>(null)

  const commit = (next: EnvRow[]): void => {
    setRows(next)
    const record = envRecordOf(next)
    setSeededFrom(record)
    onChange(record)
  }
  const setRow = (i: number, patch: Partial<EnvRow>): void => commit(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)))
  const addRow = (): void => {
    commit([...rows, { key: '', value: '' }])
    // Focus the new row's key input once it exists
    requestAnimationFrame(() => {
      const inputs = tableRef.current?.querySelectorAll<HTMLInputElement>('input.env-key')
      inputs?.[inputs.length - 1]?.focus()
    })
  }

  return (
    <div className="env-table" ref={tableRef}>
      {rows.length > 0 && (
        <div className="env-head">
          <span>{t('run.env.key')}</span>
          <span>{t('run.env.value')}</span>
          <span />
        </div>
      )}
      {rows.map((r, i) => {
        const issue = issues.get(i)
        return (
          <div className={`env-row${issue ? ' issue' : ''}`} key={i}>
            <input
              className="env-key"
              type="text"
              value={r.key}
              spellCheck={false}
              onChange={(e) => setRow(i, { key: e.target.value })}
              onPaste={(e) => {
                const next = applyEnvPaste(rows, i, e.clipboardData.getData('text'))
                if (!next) return // plain text: let the browser paste it into the cell
                e.preventDefault()
                commit(next)
              }}
            />
            <input
              className="env-value"
              type="text"
              value={r.value}
              spellCheck={false}
              onChange={(e) => setRow(i, { value: e.target.value })}
              onKeyDown={(e) => {
                // Tab out of the last value adds a row, so a list can be typed without reaching for ＋
                if (e.key === 'Tab' && !e.shiftKey && i === rows.length - 1) {
                  e.preventDefault()
                  addRow()
                }
              }}
            />
            <span className="env-issue" title={issue ? t(`run.env.issue.${issue}`) : undefined}>
              {issue && <AlertTriangle size={11} />}
            </span>
            {/* Out of the Tab sequence: Key -> Value -> next row's Key. Still reachable by mouse and by
                screen readers, which enumerate controls independently of tab order. */}
            <button
              type="button"
              className="env-remove"
              tabIndex={-1}
              title={t('run.env.removeRow')}
              onClick={() => commit(rows.filter((_, k) => k !== i))}
            >
              <X size={11} />
            </button>
          </div>
        )
      })}
      <button type="button" className="env-add" onClick={addRow}>
        <Plus size={12} />
        {t('run.env.addRow')}
      </button>
    </div>
  )
}

// The Plugin Inspector (Phase 2 remaining, spec E4): one plugin's state, version, trust level, permissions,
// contributions, Host calls and refusals, checks and recent records, read from the Host's own commands (plugins-get,
// plugins-doctor, plugins-audit). Names and counts only: a setting's value is never read here, and the log, which has
// its own button, is redacted when it is written.
import { useEffect, useState } from 'react'
import type { MessageKey } from '../../../core/i18n'
import { useI18n } from '../i18n/I18nProvider'
import { failureLine, permissionLabel, reasonLine, statusLabel, trustLabel } from './pluginsText'

/** How many recent records the Inspector asks for. */
const AUDIT_LINES = 50

export interface InspectorData {
  get: unknown
  doctor: unknown
  audit: unknown
  /** Why the plugin could not be read, when it could not. */
  error?: string
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const listOf = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObject) : [])
const when = (ms: unknown): string => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toLocaleString() : '')

const CONTRIBUTIONS = ['commands', 'panels', 'sidebar', 'statusBar', 'themes'] as const

export function PluginInspectorView({ data }: { data: InspectorData }): React.JSX.Element {
  const { t } = useI18n()
  if (!isObject(data.get)) return <p className="settings-hint">{data.error ?? t('settings.plugins.inspector.loading')}</p>
  const g = data.get
  const granted = strings(g.permissions)
  const withheld = strings(g.requested).filter((p) => !granted.includes(p))
  const contributes = isObject(g.contributes) ? g.contributes : {}
  const calls = isObject(g.calls)
    ? Object.entries(g.calls)
        .filter((e): e is [string, Record<string, unknown>] => isObject(e[1]))
        .map(([method, c]) => ({ method, ok: Number(c.ok) || 0, refused: Number(c.refused) || 0 }))
        .sort((a, b) => (a.method < b.method ? -1 : a.method > b.method ? 1 : 0))
    : []
  const checks = isObject(data.doctor) ? listOf(data.doctor.checks) : []
  const audit = isObject(data.audit) ? listOf(data.audit.entries) : listOf(data.audit)
  return (
    <div className="plugin-inspector">
      <dl className="plugin-inspector-facts">
        <dt>{t('settings.plugins.inspector.state')}</dt>
        <dd>
          {statusLabel(String(g.status ?? ''), t)}
          {typeof g.reason === 'string' && <span className="plugin-inspector-dim"> · {reasonLine(g.reason, t)}</span>}
        </dd>
        <dt>{t('settings.plugins.inspector.version')}</dt>
        <dd>{String(g.version ?? '')}</dd>
        <dt>{t('settings.plugins.inspector.trust')}</dt>
        <dd>{trustLabel(g.trust, t)}</dd>
        {typeof g.pid === 'number' && (
          <>
            <dt>{t('settings.plugins.inspector.pid')}</dt>
            <dd>{g.pid}</dd>
          </>
        )}
        {when(g.installedAt) !== '' && (
          <>
            <dt>{t('settings.plugins.inspector.installedAt')}</dt>
            <dd>{when(g.installedAt)}</dd>
          </>
        )}
      </dl>
      <h4>{t('settings.plugins.inspector.permissions')}</h4>
      <ul>
        {granted.length === 0 && <li className="plugin-inspector-dim">{t('settings.plugins.inspector.none')}</li>}
        {granted.map((p) => (
          <li key={p}>{permissionLabel(p, t)}</li>
        ))}
        {withheld.map((p) => (
          <li key={p} className="plugin-inspector-dim">
            {permissionLabel(p, t)} · {t('settings.plugins.inspector.notGranted')}
          </li>
        ))}
      </ul>
      <h4>{t('settings.plugins.inspector.contributes')}</h4>
      <ul>
        {CONTRIBUTIONS.map((k) => {
          const n = Array.isArray(contributes[k]) ? (contributes[k] as unknown[]).length : 0
          return n > 0 ? <li key={k}>{t(`settings.plugins.inspector.contrib.${k}` as MessageKey, { count: n })}</li> : null
        })}
        {CONTRIBUTIONS.every((k) => !Array.isArray(contributes[k]) || (contributes[k] as unknown[]).length === 0) && (
          <li className="plugin-inspector-dim">{t('settings.plugins.inspector.none')}</li>
        )}
      </ul>
      <h4>{t('settings.plugins.inspector.calls')}</h4>
      <ul>
        {calls.length === 0 && <li className="plugin-inspector-dim">{t('settings.plugins.inspector.callsNone')}</li>}
        {calls.map((c) => (
          <li key={c.method} className={c.refused > 0 ? 'is-refused' : undefined}>
            {t('settings.plugins.inspector.callRow', { method: c.method, ok: c.ok, refused: c.refused })}
          </li>
        ))}
      </ul>
      {checks.length > 0 && (
        <>
          <h4>{t('settings.plugins.inspector.checks')}</h4>
          <ul>
            {checks.map((c, i) => (
              <li key={i} className={c.ok === true ? (c.warn === true ? 'is-warn' : undefined) : 'is-refused'}>
                {String(c.name ?? '')}: {String(c.detail ?? '')}
              </li>
            ))}
          </ul>
        </>
      )}
      <h4>{t('settings.plugins.inspector.audit')}</h4>
      <ul className="plugin-inspector-audit">
        {audit.length === 0 && <li className="plugin-inspector-dim">{t('settings.plugins.inspector.auditNone')}</li>}
        {[...audit].reverse().map((e, i) => (
          <li key={i}>
            <span className="plugin-inspector-dim">{when(e.at)}</span> {t(`settings.plugins.inspector.event.${String(e.event)}` as MessageKey)}
            {typeof e.version === 'string' && ` ${e.version}`}
            {typeof e.detail === 'string' && <span className="plugin-inspector-dim"> · {e.detail}</span>}
            {typeof e.repeated === 'number' && e.repeated > 0 && ` ${t('settings.plugins.inspector.repeated', { count: e.repeated })}`}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Reads one plugin for the Inspector when it opens, and again when asked. */
export function PluginInspector({ id, nonce }: { id: string; nonce: number }): React.JSX.Element {
  const { t } = useI18n()
  const [data, setData] = useState<InspectorData>({ get: null, doctor: null, audit: null })
  useEffect(() => {
    let current = true
    void Promise.all([window.api.plugins.get(id), window.api.plugins.doctor(id), window.api.plugins.audit(id, AUDIT_LINES)])
      .then(([g, d, a]) => {
        if (!current) return
        setData(
          g.ok
            ? { get: g.body, doctor: d.ok ? d.body : null, audit: a.ok ? a.body : null }
            : { get: null, doctor: null, audit: null, error: failureLine(g, t, { read: true }) }
        )
      })
      .catch((e: unknown) => {
        if (current) setData({ get: null, doctor: null, audit: null, error: e instanceof Error ? e.message : String(e) })
      })
    return () => {
      current = false
    }
    // t is the language's, stable while it is one
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, nonce])
  return <PluginInspectorView data={data} />
}

import { useCallback, useEffect, useState } from 'react'
import type { RemoteApi, RemoteRuntimeInfo } from '../../../core/types'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'
import { confirmModal } from '../lib/confirm'
import { failureLine, pingLine, thisMachineLine } from './remoteRuntimesText'

type ThisMachine = Awaited<ReturnType<RemoteApi['thisMachine']>>

/** Settings › Remote Runtimes (remote runtime design Phase 6): this computer as a Runtime, the Runtimes it is paired
 *  with, and pairing a new one from the string `astera runtime pair` printed there. The token stays in main. */
export function RemoteRuntimesSettings(): React.JSX.Element {
  const { t } = useI18n()
  const [mine, setMine] = useState<ThisMachine | undefined>(undefined)
  const [paired, setPaired] = useState<RemoteRuntimeInfo[] | null>(null)
  const [pings, setPings] = useState<Record<string, string>>({})
  const [pairing, setPairing] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const reload = useCallback((): void => {
    void window.api.remote.list().then(setPaired, () => setPaired([]))
    void window.api.remote.thisMachine().then(setMine, () => setMine(null))
  }, [])
  useEffect(reload, [reload])

  const ping = async (id: string): Promise<void> => {
    const r = await window.api.remote.ping(id)
    setPings((p) => ({ ...p, [id]: pingLine(r, t as never) }))
    reload()
  }
  const remove = async (r: RemoteRuntimeInfo): Promise<void> => {
    const ok = await confirmModal({
      title: t('settings.remote.paired.remove'),
      body: t('settings.remote.paired.removeConfirm', { name: r.name }),
      confirmLabel: t('settings.remote.paired.remove')
    })
    if (!ok) return
    const done = await window.api.remote.remove(r.runtimeId)
    if (!done.ok) toast.error(failureLine(done, t as never))
    reload()
  }
  const pair = async (): Promise<void> => {
    setBusy(true)
    try {
      const done = await window.api.remote.add(pairing.trim(), name.trim() || undefined)
      if (!done.ok) {
        toast.error(failureLine(done, t as never))
        return
      }
      toast.success(t('settings.remote.pair.done', { name: String(done.runtime.name ?? done.runtime.runtimeId) }))
      setPairing('')
      setName('')
      reload()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-stack">
      <p className="settings-hint">{t('settings.remote.hint')}</p>

      <div className="settings-group">
        <div className="settings-field-label">{t('settings.remote.thisMachine.title')}</div>
        {mine !== undefined && <p className="settings-hint">{thisMachineLine(mine, t as never)}</p>}
        {mine && (mine.gateway as { fingerprint?: string }).fingerprint && (
          <p className="settings-hint">{t('settings.remote.thisMachine.fingerprint', { fingerprint: String((mine.gateway as { fingerprint?: string }).fingerprint) })}</p>
        )}
        {/* The controllers paired with this computer, only while it is a Runtime: with Remote off they cannot connect. */}
        {mine && (mine.gateway as { state: string }).state !== 'disabled' && (
          <>
            <span className="settings-hint">{t('settings.remote.thisMachine.clients')}</span>
            {mine.clients.length === 0 ? (
              <p className="settings-hint">{t('settings.remote.thisMachine.noClients')}</p>
            ) : (
              <ul className="settings-list">
                {mine.clients.map((c) => (
                  <li key={c.clientId}>
                    {c.name} · {c.permission === 'read-only' ? t('settings.remote.paired.readOnly') : t('settings.remote.paired.fullControl')}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <div className="settings-group">
        <div className="settings-field-label">{t('settings.remote.paired.title')}</div>
        {paired !== null && paired.length === 0 && <p className="settings-hint">{t('settings.remote.paired.none')}</p>}
        {paired?.map((r) => (
          <div key={r.runtimeId} className="settings-row">
            <span>
              {r.name} · {r.address}:{r.port} · {r.permission === 'read-only' ? t('settings.remote.paired.readOnly') : t('settings.remote.paired.fullControl')} ·{' '}
              {r.lastSeenAt ? t('settings.remote.paired.lastSeen', { at: new Date(r.lastSeenAt).toLocaleString() }) : t('settings.remote.paired.neverSeen')}
              {pings[r.runtimeId] && <span className="settings-hint"> · {pings[r.runtimeId]}</span>}
            </span>
            <span>
              <button className="settings-gen-refresh" onClick={() => void ping(r.runtimeId)}>
                {t('settings.remote.paired.ping')}
              </button>{' '}
              <button className="ghost danger" onClick={() => void remove(r)}>
                {t('settings.remote.paired.remove')}
              </button>
            </span>
          </div>
        ))}
      </div>

      <div className="settings-group">
        <div className="settings-field-label">{t('settings.remote.pair.title')}</div>
        <p className="settings-hint">{t('settings.remote.pair.hint')}</p>
        <input
          className="settings-gen-input"
          aria-label={t('settings.remote.pair.title')}
          placeholder="astera-pair:v1:…"
          value={pairing}
          onChange={(e) => setPairing(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        <input
          className="settings-gen-input"
          aria-label={t('settings.remote.pair.name')}
          placeholder={t('settings.remote.pair.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="primary" disabled={busy || !pairing.trim().startsWith('astera-pair:')} onClick={() => void pair()}>
          {t('settings.remote.pair.button')}
        </button>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useState } from 'react'
import type { RemoteApi, RemoteRuntimeInfo } from '../../../core/types'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'
import { confirmModal } from '../lib/confirm'
import { Select } from './Select'
import { addressLabel, controlFailureLine, failureLine, pairedStateLine, pairingLeftLine, pairingState, pingLine, revokeDoneLine, thisMachineLine } from './remoteRuntimesText'

type ThisMachine = Awaited<ReturnType<RemoteApi['thisMachine']>>
type Choice = Awaited<ReturnType<RemoteApi['addresses']>>[number]
/** A pairing string this screen made: shown while its code is live, then what became of it (pairingState). */
type Made = { pairing: string; expiresAt: string; permission: string; pairingId?: string }

/** Settings › Remote Runtimes (remote runtime design Phase 6): this computer as a Runtime (turned on on one of its
 *  addresses and off, a pairing string made for a controller, a paired controller revoked: the CLI's own runtime
 *  commands, run in main), the Runtimes it is paired with, and pairing a new one from the string a Runtime made. The
 *  token stays in main. */
export function RemoteRuntimesSettings({ onChanged }: { /** A Runtime was paired or removed: the Jobs view reads its list again. */ onChanged?: () => void } = {}): React.JSX.Element {
  const { t } = useI18n()
  const [mine, setMine] = useState<ThisMachine | undefined>(undefined)
  const [paired, setPaired] = useState<RemoteRuntimeInfo[] | null>(null)
  const [pings, setPings] = useState<Record<string, string>>({})
  const [pairing, setPairing] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  /** This computer's controls: the addresses it offers, the one chosen, a pairing being made and the one made. */
  const [choices, setChoices] = useState<Choice[]>([])
  const [listen, setListen] = useState('')
  const [switching, setSwitching] = useState(false)
  const [fullControl, setFullControl] = useState(false)
  const [pairName, setPairName] = useState('')
  const [made, setMade] = useState<Made | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const reload = useCallback((): void => {
    // A fresh list says how each Runtime is now: an old ping's line no longer stands over it (audit UI-9).
    setPings({})
    void window.api.remote.list().then(setPaired, () => setPaired([]))
    void window.api.remote.thisMachine().then(setMine, () => setMine(null))
    // The addresses are read again too: a Wi-Fi change between two visits moves them (review focus 4).
    void window.api.remote.addresses().then(
      (c) => {
        setChoices(c)
        setListen((cur) => (c.some((x) => x.address === cur) ? cur : (c[0]?.address ?? '')))
      },
      () => setChoices([])
    )
  }, [])
  useEffect(reload, [reload])

  // A pairing string's clock, and every few seconds the Host's word on its code (used, dropped by a stop from the CLI,
  // or gone with a Host restart), only while a live one is on screen. With Remote off it goes.
  const madeState = made ? pairingState(made, mine ?? null, now) : null
  useEffect(() => {
    if (madeState !== 'live') return
    let tick = 0
    const timer = setInterval(() => {
      setNow(Date.now())
      if (++tick % 3 === 0) void window.api.remote.thisMachine().then(setMine, () => setMine(null))
    }, 1000)
    return () => clearInterval(timer)
  }, [madeState])
  useEffect(() => {
    if (madeState === 'gone') setMade(null)
  }, [madeState])

  /** One control at a time from this screen; main runs them one at a time as well. */
  const control = async (work: () => Promise<void>): Promise<void> => {
    if (switching) return
    setSwitching(true)
    try {
      await work()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSwitching(false)
      reload()
    }
  }
  const turnOn = (): Promise<void> =>
    control(async () => {
      const r = await window.api.remote.start(listen)
      if (!r.ok) return void toast.error(controlFailureLine(r, 'start', t as never))
      toast.success(t('settings.remote.start.done', { listen: String(r.body.listen ?? listen), port: String(r.body.port ?? '') }))
    })
  const turnOff = async (): Promise<void> => {
    const ok = await confirmModal({ title: t('settings.remote.stop.title'), body: t('settings.remote.stop.body'), confirmLabel: t('settings.remote.stop.button') })
    if (!ok) return
    await control(async () => {
      const r = await window.api.remote.stop()
      if (!r.ok) return void toast.error(controlFailureLine(r, 'stop', t as never))
      setMade(null)
      toast.success(t('settings.remote.stop.done'))
    })
  }
  const makePairing = (): Promise<void> =>
    control(async () => {
      const r = await window.api.remote.pair({ fullControl, ...(pairName.trim() ? { name: pairName.trim() } : {}) })
      if (!r.ok) return void toast.error(controlFailureLine(r, 'pair', t as never))
      setNow(Date.now())
      setMade({
        pairing: String(r.body.pairing),
        expiresAt: String(r.body.expiresAt),
        permission: String(r.body.permission),
        ...(typeof r.body.pairingId === 'string' ? { pairingId: r.body.pairingId } : {})
      })
      setPairName('')
      // The next string starts from read-only again: full control is chosen for one controller at a time (minor 8).
      setFullControl(false)
    })
  const copyPairing = (): void => {
    if (!made) return
    window.api.clipboard.writeText(made.pairing)
    toast.success(t('settings.remote.newPair.copied'))
  }
  const revoke = async (c: { clientId: string; name: string }): Promise<void> => {
    const ok = await confirmModal({ title: t('settings.remote.revoke.title'), body: t('settings.remote.revoke.body', { name: c.name }), confirmLabel: t('settings.remote.revoke.button') })
    if (!ok) return
    await control(async () => {
      const r = await window.api.remote.revoke(c.clientId)
      if (!r.ok) return void toast.error(controlFailureLine(r, 'revoke', t as never))
      // The Host's counts of the scheduled Jobs it paused (remote governance design §8.2), through runRuntimeCommand's body
      toast.success(revokeDoneLine({ ...(r.body as Parameters<typeof revokeDoneLine>[0]), name: c.name }, t as never))
    })
  }
  const remoteOn = !!mine && (mine.gateway as { state: string }).state !== 'disabled'
  /** A pairing string is made only on a Gateway that listens: one that failed would hand out an address nothing serves. */
  const gatewayState = mine ? String((mine.gateway as { state: string }).state) : ''

  const ping = async (id: string): Promise<void> => {
    if (pinging.has(id)) return
    setPinging((s) => new Set(s).add(id))
    try {
      const r = await window.api.remote.ping(id)
      reload()
      setPings((p) => ({ ...p, [id]: pingLine(r, t as never) }))
    } catch (err) {
      // Said, not left unhandled (audit UI-9).
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setPinging((s) => {
        const n = new Set(s)
        n.delete(id)
        return n
      })
    }
  }
  /** Runtimes with a ping in flight (audit UI-9). */
  const [pinging, setPinging] = useState<Set<string>>(new Set())
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
    onChanged?.()
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
      onChanged?.()
    } catch (err) {
      // Said, not left unhandled (audit UI-9).
      toast.error(err instanceof Error ? err.message : String(err))
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
        {/* Off: an address of this computer to listen on, and on. On: off, a pairing string, and the controllers. With
            the Host unable to say (mine null), nothing is offered: the answer would be a guess. */}
        {mine && !remoteOn && (
          <>
            <div className="settings-row">
              <span>{t('settings.remote.start.address')}</span>
              <Select
                className="settings-gen-select"
                ariaLabel={t('settings.remote.start.address')}
                value={listen}
                onChange={setListen}
                items={choices.map((c) => ({ value: c.address, label: addressLabel(c, t as never) }))}
              />
            </div>
            <span className="settings-hint">{t('settings.remote.start.hint')}</span>
            <div className="remote-actions is-end">
              <button className="primary" disabled={switching || listen === ''} onClick={() => void turnOn()}>
                {t('settings.remote.start.button')}
              </button>
            </div>
          </>
        )}
        {mine && remoteOn && (
          <>
            <div className="remote-actions is-end">
              <button className="ghost danger" disabled={switching} onClick={() => void turnOff()}>
                {t('settings.remote.stop.button')}
              </button>
            </div>

            <div className="settings-field-label">{t('settings.remote.newPair.title')}</div>
            <div className="remote-actions">
              <Select
                className="settings-gen-select"
                ariaLabel={t('settings.remote.newPair.title')}
                value={fullControl ? 'full-control' : 'read-only'}
                onChange={(v) => setFullControl(v === 'full-control')}
                items={[
                  { value: 'read-only', label: t('settings.remote.newPair.readOnly') },
                  { value: 'full-control', label: t('settings.remote.newPair.fullControl') }
                ]}
              />
              <input
                className="settings-gen-input remote-actions-grow"
                aria-label={t('settings.remote.newPair.name')}
                placeholder={t('settings.remote.newPair.name')}
                value={pairName}
                maxLength={64}
                onChange={(e) => setPairName(e.target.value)}
              />
              <button className="primary" disabled={switching || gatewayState !== 'ready'} onClick={() => void makePairing()}>
                {t('settings.remote.newPair.button')}
              </button>
            </div>
            {gatewayState !== 'ready' && <p className="settings-hint">{t('settings.remote.newPair.notReady', { state: gatewayState })}</p>}
            {fullControl && <p className="settings-hint is-warning">{t('settings.remote.newPair.fullControlWarning')}</p>}
            {made && madeState === 'expired' && <p className="settings-hint">{t('settings.remote.newPair.expired')}</p>}
            {made && madeState === 'spent' && <p className="settings-hint">{t('settings.remote.newPair.spent')}</p>}
            {made && madeState === 'live' && (
              <>
                <div className="remote-actions">
                  <input className="settings-gen-input remote-actions-grow" readOnly value={made.pairing} aria-label={t('settings.remote.newPair.title')} spellCheck={false} onFocus={(e) => e.target.select()} />
                  <button className="settings-gen-refresh" onClick={copyPairing}>
                    {t('settings.remote.newPair.copy')}
                  </button>
                </div>
                <p className="settings-hint">
                  {made.permission === 'full-control' ? t('settings.remote.paired.fullControl') : t('settings.remote.paired.readOnly')} · {pairingLeftLine(made.expiresAt, now, t as never)}
                </p>
                <p className="settings-hint">{t('settings.remote.newPair.secret')}</p>
              </>
            )}
          </>
        )}
        {/* The controllers paired with this computer, on or off: a pairing outlives turning Remote off, and one lost with
            a laptop is unpaired here without turning Remote on again for it (final review I2). */}
        {mine && (
          <>
            <span className="settings-hint">{t('settings.remote.thisMachine.clients')}</span>
            {mine.clients.length === 0 ? (
              <p className="settings-hint">{t('settings.remote.thisMachine.noClients')}</p>
            ) : (
              mine.clients.map((c) => (
                <div key={c.clientId} className="settings-row">
                  <span>
                    {c.name} · {c.permission === 'read-only' ? t('settings.remote.paired.readOnly') : t('settings.remote.paired.fullControl')}
                  </span>
                  <button className="ghost danger" disabled={switching} onClick={() => void revoke(c)}>
                    {t('settings.remote.revoke.button')}
                  </button>
                </div>
              ))
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
              {pings[r.runtimeId] ? (
                <span className="settings-hint"> · {pings[r.runtimeId]}</span>
              ) : (
                pairedStateLine(r, t as never) && <span className="settings-hint"> · {pairedStateLine(r, t as never)}</span>
              )}
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

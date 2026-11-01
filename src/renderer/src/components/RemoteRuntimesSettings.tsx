import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteApi, RemoteRuntimeInfo, RuntimeDetail } from '../../../core/types'
import type { MessageKey } from '../../../core/i18n'
import type { AuditMode } from '../../../core/audit/types'
import type { ProfilePermission } from '../../../core/agentProfiles/types'
import type { ControlPlaneReport } from '../../../core/controlPlane/report'
import { PROVIDERS, PROVIDER_META } from '../../../core/providers/meta'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'
import { confirmModal } from '../lib/confirm'
import { Select } from './Select'
import { localTime } from './findingsText'
import { coverageRowLabel, modeLabel } from './securityText'
import {
  addressLabel,
  answerLine,
  clientSeenLine,
  controlFailureLine,
  expectFailureLine,
  failureLine,
  freshnessLines,
  pairedStateLine,
  pairingLeftLine,
  pairingState,
  pingLine,
  revokeDoneLine,
  stateWord,
  thisMachineLine,
  versionLine
} from './remoteRuntimesText'

type ThisMachine = Awaited<ReturnType<RemoteApi['thisMachine']>>
type Choice = Awaited<ReturnType<RemoteApi['addresses']>>[number]
/** A pairing string this screen made: shown while its code is live, then what became of it (pairingState). */
type Made = { pairing: string; expiresAt: string; permission: string; pairingId?: string }

/** Settings › Remote Runtimes (remote runtime design Phase 6): this computer as a Runtime (turned on on one of its
 *  addresses and off, a pairing string made for a controller, a paired controller revoked: the CLI's own runtime
 *  commands, run in main), the Runtimes it is paired with, and pairing a new one from the string a Runtime made. The
 *  token stays in main. */
export function RemoteRuntimesSettings({
  onChanged,
  focusRuntimeId
}: {
  /** A Runtime was paired or removed: the Jobs view reads its list again. */
  onChanged?: () => void
  /** The Runtime a finding's button opened this tab for (remote governance design §6.3): its detail opens. */
  focusRuntimeId?: string
} = {}): React.JSX.Element {
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
  /** This app's version, which an older Runtime's row names beside its own (remote governance design §4.3). */
  const [appVersion, setAppVersion] = useState('')
  /** The paired Runtime whose detail is open below its row (§10.1), what it read (or why it could not), and whether a
   *  read is running. */
  const [openId, setOpenId] = useState<string | null>(null)
  const [detail, setDetail] = useState<RuntimeDetail | { code: string; message: string } | null>(null)
  const [reading, setReading] = useState(false)
  /** Which detail read is the latest: a slower answer to an earlier one, or one for a row closed since, is dropped. */
  const detailRead = useRef(0)

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
  // The paired Runtimes' reports, read once when the tab opens (§5.4), never awaited first: the list shows at once and is
  // read again when they are in, for what they changed (an older version, last seen). readReports never rejects.
  useEffect(() => {
    void window.api.system.appVersion().then(setAppVersion, () => undefined)
    void window.api.remote.readReports().then(() => window.api.remote.list().then(setPaired, () => undefined))
  }, [])

  /** Reads `id`'s detail: the kept report while it is recent, a fresh one on Refresh (§5.4). The list is read again after,
   *  for the offline state and last seen this read heard. */
  const readDetail = async (id: string, refresh = false): Promise<void> => {
    const n = ++detailRead.current
    setReading(true)
    try {
      const d = await (refresh ? window.api.remote.detail(id, true) : window.api.remote.detail(id)).catch((e: unknown) => ({
        code: 'FAILED',
        message: e instanceof Error ? e.message : String(e)
      }))
      if (n !== detailRead.current) return
      setDetail(d)
      void window.api.remote.list().then(setPaired, () => undefined)
    } finally {
      if (n === detailRead.current) setReading(false)
    }
  }
  const openDetail = (id: string): void => {
    setOpenId(id)
    setDetail(null)
    void readDetail(id)
  }
  const toggleDetail = (id: string): void => {
    if (openId !== id) return openDetail(id)
    detailRead.current++
    setOpenId(null)
    setDetail(null)
    setReading(false)
  }
  /** Marks one of this computer's extensions expected there or not (§6.1), then reads the detail again without asking the
   *  Runtime: the kept report compared with the list as it is now. */
  const setExpected = async (id: string, on: boolean): Promise<void> => {
    if (openId === null) return
    const runtimeId = openId
    const r = await window.api.remote
      .expect(runtimeId, on ? [id] : [], on ? [] : [id])
      .catch((e: unknown) => ({ ok: false as const, code: 'FAILED', message: e instanceof Error ? e.message : String(e) }))
    if (!r.ok) toast.error(expectFailureLine(r, t as never))
    await readDetail(runtimeId)
  }
  // A finding's button opens its Runtime's detail once the list has it, once per opening, as Agent profiles scrolls to
  // its profile once
  const focusedFor = useRef<string | null>(null)
  const rows = useRef(new Map<string, HTMLDivElement>())
  useEffect(() => {
    if (focusRuntimeId === undefined || focusedFor.current === focusRuntimeId || paired === null) return
    if (!paired.some((r) => r.runtimeId === focusRuntimeId)) return
    focusedFor.current = focusRuntimeId
    openDetail(focusRuntimeId)
    rows.current.get(focusRuntimeId)?.scrollIntoView({ block: 'start' })
  }, [focusRuntimeId, paired])

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
      const body = { ...(r.body as Parameters<typeof revokeDoneLine>[0]), name: c.name }
      // A schedule whose pause was refused is still armed, and the person has to see that (ruling R8-3). The toast has no
      // warning kind, so it is the kind that stays until it is closed (lib/toast.ts: an error is never auto-dismissed).
      if ((body.notPaused ?? []).length > 0) toast.error(revokeDoneLine(body, t as never))
      else toast.success(revokeDoneLine(body, t as never))
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
                    {c.name} · {c.permission === 'read-only' ? t('settings.remote.paired.readOnly') : t('settings.remote.paired.fullControl')} ·{' '}
                    {clientSeenLine(c, t as never)}
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
          <Fragment key={r.runtimeId}>
            <div
              className="settings-row"
              ref={(el) => {
                if (el) rows.current.set(r.runtimeId, el)
                else rows.current.delete(r.runtimeId)
              }}
            >
              <span>
                {r.name} · {r.address}:{r.port} · {r.permission === 'read-only' ? t('settings.remote.paired.readOnly') : t('settings.remote.paired.fullControl')} ·{' '}
                {r.lastSeenAt ? t('settings.remote.paired.lastSeen', { at: new Date(r.lastSeenAt).toLocaleString() }) : t('settings.remote.paired.neverSeen')}
                {pings[r.runtimeId] ? (
                  <span className="settings-hint"> · {pings[r.runtimeId]}</span>
                ) : (
                  pairedStateLine(r, t as never) && <span className="settings-hint"> · {pairedStateLine(r, t as never)}</span>
                )}
                {/* An older Runtime says so on its row (§4.3); a newer one is shown in its detail, not flagged here */}
                {r.older && r.asteraVersion !== undefined && appVersion !== '' && (
                  <span className="settings-hint is-warning"> · {versionLine({ facts: { asteraVersion: r.asteraVersion }, here: appVersion, older: true }, t as never)}</span>
                )}
              </span>
              <span>
                <button className="settings-gen-refresh" aria-expanded={openId === r.runtimeId} onClick={() => toggleDetail(r.runtimeId)}>
                  {t('settings.remote.detail.open')}
                </button>{' '}
                <button className="settings-gen-refresh" onClick={() => void ping(r.runtimeId)}>
                  {t('settings.remote.paired.ping')}
                </button>{' '}
                <button className="ghost danger" onClick={() => void remove(r)}>
                  {t('settings.remote.paired.remove')}
                </button>
              </span>
            </div>
            {openId === r.runtimeId &&
              (detail === null ? (
                <p className="settings-hint">…</p>
              ) : 'code' in detail ? (
                <p className="settings-hint is-warning">{failureLine({ ok: false, ...detail }, t as never)}</p>
              ) : (
                <RuntimeDetailView detail={detail} busy={reading} onRefresh={() => void readDetail(r.runtimeId, true)} onExpect={(id, on) => void setExpected(id, on)} now={now} />
              ))}
          </Fragment>
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

const PERMISSION_KEYS: Record<ProfilePermission, MessageKey> = {
  inherit: 'settings.agentProfiles.permission.inherit',
  bypass: 'settings.agentProfiles.permission.bypass',
  ask: 'settings.agentProfiles.permission.ask'
}
const OTHERWISE_KEYS: Record<'allow' | 'deny', MessageKey> = { allow: 'settings.security.effect.allow', deny: 'settings.security.effect.deny' }
const SANDBOX_KIND_KEYS: Record<'sandbox' | 'deny-only', MessageKey> = {
  sandbox: 'settings.remote.detail.sandboxKind.sandbox',
  'deny-only': 'settings.remote.detail.sandboxKind.denyOnly'
}
const MODES: readonly string[] = ['compatibility', 'observe', 'enforce'] satisfies AuditMode[]
/** A state word in the person's language where this build knows it; a newer Runtime's word as it came (ruling R2-1). */
const wordOf = (keys: Record<string, MessageKey>, word: string, t: (k: MessageKey) => string): string => (Object.hasOwn(keys, word) ? t(keys[word]) : word)
/** How long a fingerprint is on screen; the whole one goes to the clipboard (§10.1). */
const FINGERPRINT_SHOWN = 16

/** A paired Runtime's detail below its row (remote governance design §10.1): who it is, how it answers and what it runs,
 *  this computer's extensions beside its own with a checkbox per entry here for what to expect there, and its
 *  credentials' names, secret store and findings count. A part the Runtime could not read says so rather than reading as
 *  empty (ruling R9-3). Offline, the last report shows under the "does not answer" line with the time it was read (§5.4).
 *  Pure apart from the clipboard, so its markup is tested without the Host. */
export function RuntimeDetailView(p: { detail: RuntimeDetail; busy: boolean; onRefresh(): void; onExpect(id: string, on: boolean): void; now: number }): React.JSX.Element {
  const { t } = useI18n()
  const d = p.detail
  const r = d.snapshot?.report ?? null
  const cannotReport = d.refusal?.code === 'RUNTIME_CAPABILITY_MISSING'
  // The unsupported line already says to update there, so the version line does not say it again
  const versions = versionLine({ facts: d.facts, here: d.here, older: d.older && !cannotReport }, t as never)
  const answer = answerLine(d, t as never)
  const short = d.fingerprint.length > FINGERPRINT_SHOWN ? `${d.fingerprint.slice(0, FINGERPRINT_SHOWN)}…` : d.fingerprint
  const copyFingerprint = (): void => {
    window.api.clipboard.writeText(d.fingerprint)
    toast.success(t('settings.remote.newPair.copied'))
  }
  const unread = <p className="settings-hint is-warning">{t('settings.remote.detail.unread')}</p>
  const enforceWord = (code: string | null): string =>
    code === null ? t('settings.remote.detail.enforceReady') : t('settings.remote.detail.enforceBlocked', { code })
  const onOff = (e: { enabled: boolean } | null): string => (e === null ? '' : t(e.enabled ? 'settings.remote.detail.entryOn' : 'settings.remote.detail.entryOff'))
  const fixThere = d.comparison.some((c) => c.state !== null && c.state !== 'same')

  return (
    <div className="settings-stack">
      <div className="settings-group">
        <div className="settings-field-label">{t('settings.remote.detail.identity')}</div>
        <p className="settings-hint">{t('settings.remote.detail.runtimeId', { id: d.runtimeId })}</p>
        <div className="remote-actions">
          <span className="settings-hint">{t('settings.remote.detail.fingerprint', { fingerprint: short })}</span>
          <button className="settings-gen-refresh" onClick={copyFingerprint}>
            {t('settings.remote.detail.copyFingerprint')}
          </button>
        </div>
        <p className="settings-hint">
          {t('settings.remote.detail.pairedAt', { at: localTime(d.createdAt) })} · {d.permission === 'read-only' ? t('settings.remote.paired.readOnly') : t('settings.remote.paired.fullControl')}
        </p>
      </div>

      <div className="settings-group">
        <div className="settings-field-label">{t('settings.remote.detail.health')}</div>
        <p className="settings-hint">{d.lastSeenAt === null ? t('settings.remote.paired.neverSeen') : t('settings.remote.paired.lastSeen', { at: localTime(d.lastSeenAt) })}</p>
        {answer !== null && <p className={d.answering === true ? 'settings-hint' : 'settings-hint is-warning'}>{answer}</p>}
        {versions !== null && <p className={d.older && !cannotReport ? 'settings-hint is-warning' : 'settings-hint'}>{versions}</p>}
        {d.facts !== null && <p className="settings-hint">{t('settings.remote.detail.os', { platform: d.facts.platform })}</p>}
        {freshnessLines(d, t as never).map((line) => (
          <p key={line} className="settings-hint">
            {line}
          </p>
        ))}
        <button className="settings-gen-refresh" disabled={p.busy} onClick={p.onRefresh}>
          {t('settings.remote.detail.refresh')}
        </button>
      </div>

      {r !== null && (
        <>
          <div className="settings-group">
            <div className="settings-field-label">{t('settings.remote.detail.agents')}</div>
            {r.appBypass !== null && <p className="settings-hint">{t(r.appBypass ? 'settings.remote.detail.bypassOn' : 'settings.remote.detail.bypassOff')}</p>}
            {r.profiles === null
              ? unread
              : r.profiles.map((profile) => (
                  <p key={profile.id} className="settings-hint">
                    {[
                      profile.name,
                      profile.status === 'active' ? '' : profile.status === 'archived' ? t('settings.agentProfiles.archived') : profile.status,
                      wordOf(PERMISSION_KEYS, profile.permission, t),
                      t(profile.sandbox ? 'settings.remote.detail.sandboxOn' : 'settings.remote.detail.sandboxOff'),
                      t('settings.remote.detail.accounts', { there: profile.accountsThere, named: profile.accountsNamed })
                    ]
                      .filter((w) => w !== '')
                      .join(' · ')}
                  </p>
                ))}
          </div>

          <div className="settings-group">
            <div className="settings-field-label">{t('settings.remote.detail.protection')}</div>
            {r.policy === null ? (
              unread
            ) : (
              <p className="settings-hint">
                {t('settings.remote.detail.policy', {
                  mode: MODES.includes(r.policy.mode) ? modeLabel(r.policy.mode as AuditMode, t) : r.policy.mode,
                  otherwise: wordOf(OTHERWISE_KEYS, r.policy.otherwise, t),
                  rules: r.policy.rules
                })}
              </p>
            )}
            {PROVIDERS.map((provider) => {
              const name = PROVIDER_META[provider].displayName
              const enforce = r.policy?.enforce?.[provider]
              const sandbox = r.sandbox[provider]
              const cli = r.policy === null ? undefined : r.policy.cliVersions[provider]
              return (
                <Fragment key={provider}>
                  {enforce !== undefined && (
                    <>
                      <p className="settings-hint">
                        {coverageRowLabel({ provider, kind: 'terminal' }, t)}: {enforceWord(enforce.terminal)}
                      </p>
                      <p className="settings-hint">
                        {coverageRowLabel({ provider, kind: 'chat' }, t)}: {enforceWord(enforce.chat)}
                      </p>
                    </>
                  )}
                  <p className="settings-hint">
                    {t('settings.remote.detail.sandbox', { provider: name, kind: wordOf(SANDBOX_KIND_KEYS, sandbox.kind, t) })}
                    {sandbox.blocker === null ? '' : ` (${sandbox.blocker})`}
                  </p>
                  {cli !== undefined && (
                    <p className="settings-hint">
                      {cli === null ? t('settings.remote.detail.cliMissing', { provider: name }) : t('settings.remote.detail.cliVersion', { provider: name, version: cli })}
                    </p>
                  )}
                </Fragment>
              )
            })}
            {r.sandbox.codexAccounts !== undefined && (
              <p className="settings-hint">{t('settings.remote.detail.codexAccounts', { ready: r.sandbox.codexAccounts.ready, total: r.sandbox.codexAccounts.total })}</p>
            )}
          </div>

          <div className="settings-group">
            <div className="settings-field-label">{t('settings.remote.detail.extensions')}</div>
            {d.localError ? (
              <p className="settings-hint is-warning">{t('settings.remote.detail.localError')}</p>
            ) : r.extensions === null ? (
              <p className="settings-hint is-warning">{t('settings.remote.detail.extensionsUnread')}</p>
            ) : (
              d.comparison.length > 0 && (
                <div className="security-table-wrap">
                  <table className="security-table">
                    <thead>
                      <tr>
                        <th scope="col">{t('settings.remote.detail.expected')}</th>
                        <th scope="col">{t('settings.remote.detail.entry')}</th>
                        <th scope="col">{t('settings.remote.detail.hereColumn')}</th>
                        <th scope="col">{t('settings.remote.detail.thereColumn')}</th>
                        <th scope="col">{t('settings.remote.detail.stateColumn')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.comparison.map((row, n) => (
                        <Fragment key={`${row.kind}:${row.id}`}>
                          {/* The rows come sorted by kind (compareExtensions): a heading where each kind starts */}
                          {d.comparison[n - 1]?.kind !== row.kind && (
                            <tr>
                              <th colSpan={5}>{t(`settings.extensions.kind.${row.kind}`)}</th>
                            </tr>
                          )}
                          <tr>
                            <td>
                              {row.here !== null && (
                                <input
                                  type="checkbox"
                                  checked={row.expected}
                                  disabled={p.busy}
                                  aria-label={`${t('settings.remote.detail.expected')}: ${row.name}`}
                                  onChange={(e) => p.onExpect(row.id, e.target.checked)}
                                />
                              )}
                            </td>
                            <td>{row.name}</td>
                            <td>{onOff(row.here)}</td>
                            <td>{onOff(row.there)}</td>
                            <td>{stateWord(row, t as never)}</td>
                          </tr>
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            )}
            {fixThere && <p className="settings-hint">{t('settings.remote.detail.installThere')}</p>}
          </div>

          <div className="settings-group">
            <div className="settings-field-label">{t('settings.remote.detail.credentials')}</div>
            <p className="settings-hint">{t('settings.remote.detail.valuesStay')}</p>
            {r.credentials === null
              ? unread
              : [
                  ...r.credentials.hideOnly.map((h) => ({ key: `h:${h.alias}`, name: h.alias, names: h.envNames, hidden: h.hidden })),
                  ...r.credentials.mcp.map((m) => ({ key: `m:${m.serverId}`, name: m.serverName, names: m.names, hidden: m.hidden }))
                ].map((c) => (
                  <p key={c.key} className="settings-hint">
                    {c.name} · {c.names.join(', ')} · {t(c.hidden ? 'settings.remote.detail.hidden' : 'settings.remote.detail.notHidden')}
                  </p>
                ))}
          </div>

          <div className="settings-group">
            <p className={r.secretStore.ok ? 'settings-hint' : 'settings-hint is-warning'}>
              {secretStoreLine(r.secretStore, t)}
            </p>
            {r.findings !== null && <p className="settings-hint">{t('settings.remote.detail.findingsThere', { count: r.findings.total })}</p>}
          </div>
        </>
      )}
    </div>
  )
}

/** The Runtime's secret store and its check (§5.2): a failed check with its code, lowercase as the Runtime sends it; a
 *  kind this build does not know named as its word (ruling R2-1). */
function secretStoreLine(s: ControlPlaneReport['secretStore'], t: (k: MessageKey, p?: Record<string, string | number>) => string): string {
  const state = s.ok ? t('settings.remote.detail.secretStoreOk') : t('settings.remote.detail.secretStoreFailed', { code: s.code ?? 'failed' })
  return s.kind === 'owner-only-files' ? t('settings.remote.detail.secretStore', { state }) : t('settings.remote.detail.secretStoreOther', { kind: s.kind, state })
}

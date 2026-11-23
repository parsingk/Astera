import { useEffect, useId, useRef, useState } from 'react'
import { ArrowLeftRight } from 'lucide-react'
import type { ForwardSpec, ObjectRef } from '../../../../../core/kube/cluster/types'
import { forwardPorts, validPort } from '../../../../../core/kube/cluster/forward'
import { displayContextName } from '../../../../../core/kube/contextName'
import type { K8sObject } from '../../../../../core/kube/objects'
import { useI18n } from '../../../i18n/I18nProvider'
import { backdropProps } from '../../../lib/backdrop'

const OTHER = 'other'

/** The text as a whole number (`'80'` is 80, `'80a'` and `''` are NaN), so `validPort` judges it. */
const portOf = (text: string): number => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : NaN)

/** Starts one port forward (cluster view, board F). The remote port is a known port of the object or "other"; the
 *  local port follows `localPort`'s free answer for it until the person types there. State lives here, the start
 *  itself with the caller. */
export function KubeForwardDialog({
  target,
  object,
  onStart,
  onCancel
}: {
  target: ObjectRef
  object: K8sObject
  onStart: (spec: ForwardSpec) => void
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const ports = forwardPorts(object)
  const [choice, setChoice] = useState<string>(ports.length > 0 ? String(ports[0].port) : OTHER)
  const [otherText, setOtherText] = useState('')
  const [localText, setLocalText] = useState('')
  const uid = useId()
  const ids = {
    title: `${uid}-title`,
    remote: `${uid}-remote`,
    other: `${uid}-other`,
    local: `${uid}-local`,
    otherBad: `${uid}-other-bad`,
    localBad: `${uid}-local-bad`
  }
  const typedLocal = useRef(false)
  const request = useRef(0)

  const remote = choice === OTHER ? portOf(otherText) : Number(choice)
  const local = portOf(localText)
  const remoteOk = validPort(remote)
  const localOk = validPort(local)
  const canStart = remoteOk && localOk

  useEffect(() => {
    if (!remoteOk) return
    const mine = ++request.current
    window.api.kube.forward
      .localPort(remote)
      .then((port) => {
        if (mine === request.current && !typedLocal.current) setLocalText(String(port))
      })
      .catch(() => {})
    return () => {
      // a newer request or the unmount makes this answer stale
      if (request.current === mine) request.current++
    }
  }, [remote, remoteOk])

  const start = (): void => {
    if (!canStart) return
    const known = choice === OTHER ? undefined : ports.find((p) => p.port === remote)?.name
    onStart({ ref: target, local, remote, ...(known !== undefined ? { remoteName: known } : {}) })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const el = document.activeElement
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return
      onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const onFieldKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      start()
    }
  }

  const ctx = displayContextName(target.context)
  const isBad = (text: string, n: number): boolean => text.trim() !== '' && !validPort(n)
  const bad = (id: string): React.JSX.Element => (
    <div id={id} className="kube-forward-bad">
      {t('kube.forward.badPort')}
    </div>
  )
  const otherBad = choice === OTHER && isBad(otherText, remote)
  const localBad = isBad(localText, local)

  return (
    <div className="modal-backdrop" {...backdropProps(onCancel)}>
      <div
        className="modal kube-forward"
        role="dialog"
        aria-modal="true"
        aria-labelledby={ids.title}
        onClick={(e) => e.stopPropagation()}>
        <h2 id={ids.title} className="kube-forward-title">
          <ArrowLeftRight size={15} aria-hidden="true" />
          {t('kube.forward.title')}
        </h2>
        <div className="kube-forward-form">
          <span className="kube-forward-label">{t('kube.forward.target')}</span>
          <div className="kube-forward-target">
            <span className="kube-chip-kind">{target.kind}</span>
            <span className="mono">{target.name}</span>
            <span className="kube-forward-dim">
              {ctx.short}
              {target.namespace !== null ? ` / ${target.namespace}` : ''}
            </span>
          </div>

          <label className="kube-forward-label" htmlFor={ports.length > 0 ? ids.remote : ids.other}>
            {t('kube.forward.remote')}
          </label>
          <div className="kube-field">
            {ports.length > 0 && (
              <select id={ids.remote} value={choice} onChange={(e) => setChoice(e.target.value)} onKeyDown={onFieldKey}>
                {ports.map((p) => (
                  <option key={p.port} value={String(p.port)}>
                    {p.name !== undefined ? `${p.port} ${p.name}` : String(p.port)}
                  </option>
                ))}
                <option value={OTHER}>{t('kube.forward.other')}</option>
              </select>
            )}
            {choice === OTHER && (
              <input
                id={ids.other}
                type="text"
                inputMode="numeric"
                className="mono"
                autoComplete="off"
                aria-label={ports.length > 0 ? t('kube.forward.other') : undefined}
                aria-invalid={otherBad || undefined}
                aria-describedby={otherBad ? ids.otherBad : undefined}
                value={otherText}
                autoFocus={ports.length === 0}
                onChange={(e) => setOtherText(e.target.value)}
                onKeyDown={onFieldKey}
              />
            )}
            {otherBad && bad(ids.otherBad)}
          </div>

          <label className="kube-forward-label" htmlFor={ids.local}>
            {t('kube.forward.local')}
          </label>
          <div className="kube-field">
            <input
              id={ids.local}
              type="text"
              inputMode="numeric"
              className="mono"
              autoComplete="off"
              aria-invalid={localBad || undefined}
              aria-describedby={localBad ? ids.localBad : undefined}
              value={localText}
              onChange={(e) => {
                typedLocal.current = true
                setLocalText(e.target.value)
              }}
              onKeyDown={onFieldKey}
            />
            {localBad && bad(ids.localBad)}
          </div>
        </div>
        <div className="row right">
          <button type="button" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button type="button" className="primary" disabled={!canStart} onClick={start}>
            {t('kube.forward.start')}
          </button>
        </div>
      </div>
    </div>
  )
}

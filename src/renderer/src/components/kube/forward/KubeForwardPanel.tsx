import { useEffect, useState } from 'react'
import { Globe, RotateCw, Square, X } from 'lucide-react'
import { useI18n } from '../../../i18n/I18nProvider'
import type { MessageKey } from '../../../../../core/i18n'
import { LOST, LOST_POD, REFUSED, FORWARD_ADDRESS } from '../../../../../core/kube/cluster/forward'
import { runText } from '../../../../../core/kube/cluster/status'
import { displayContextName } from '../../../../../core/kube/contextName'
import { forwardRunMs, isLive, type KubeForward } from '../../../lib/kubeForwards'

/** The Port forwarding segment (spec 4.10, board F): the switch with a stop all button, then one row per forward. Ended
 *  rows stay so the person sees how each ended and can start it again or remove it. */
export function KubeForwardPanel({
  switcher,
  forwards,
  onOpen,
  onStop,
  onStopAll,
  onReconnect,
  onRemove
}: {
  switcher: React.ReactNode
  forwards: KubeForward[]
  onOpen(f: KubeForward, ev: React.MouseEvent): void
  onStop(id: string): void
  onStopAll(): void
  onReconnect(id: string): void
  onRemove(id: string): void
}): React.JSX.Element {
  const { t } = useI18n()
  const connected = forwards.some((f) => f.state === 'connected')
  const [now, setNow] = useState(() => Date.now())
  // The run time of a connected row counts up; nothing else on the list moves with the clock.
  useEffect(() => {
    if (!connected) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [connected])

  const stateText = (f: KubeForward): string => {
    if (f.state !== 'disconnected' && f.state !== 'failed') return t(`kube.forward.state.${f.state}`)
    if (f.reason === null) return t(`kube.forward.state.${f.state}Plain`)
    const named = { [LOST_POD]: 'kube.forward.lostPod', [LOST]: 'kube.forward.lost', [REFUSED]: 'kube.forward.refused' } as const
    const reason = f.reason in named ? t(named[f.reason as keyof typeof named]) : f.reason
    return t(`kube.forward.state.${f.state}`, { reason })
  }
  // Each action has its own fixed slot, empty where it does not apply, so a button never moves under a double-click.
  const slot = (shown: boolean, label: MessageKey, icon: React.ReactNode, run: (ev: React.MouseEvent) => void): React.JSX.Element =>
    shown ? (
      <span className="kube-forward-slot">
        <button type="button" className="icon-btn" title={t(label)} aria-label={t(label)} onClick={(ev) => run(ev)}>
          {icon}
        </button>
      </span>
    ) : (
      <span className="kube-forward-slot" />
    )

  return (
    <>
      <div className="kube-segment-bar">
        {switcher}
        <span className="kube-segment-spacer" />
        <button
          type="button"
          className="icon-btn"
          title={t('kube.forward.stopAll')}
          aria-label={t('kube.forward.stopAll')}
          disabled={!forwards.some(isLive)}
          onClick={onStopAll}
        >
          <Square size={13} />
        </button>
      </div>
      {forwards.length === 0 ? (
        <div className="kube-cluster-empty">{t('kube.forward.empty')}</div>
      ) : (
        <div className="kube-cluster-table kube-forward-table">
          <table>
            <thead>
              <tr>
                {(['target', 'local', 'remote', 'cluster', 'state', 'age'] as const).map((c) => (
                  <th key={c}>
                    <span className="kube-forward-th">{t(`kube.forward.col.${c}`)}</span>
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {forwards.map((f) => {
                const { ref, local, remote, remoteName } = f.spec
                const run = forwardRunMs(f, now)
                const bad = f.state === 'disconnected' || f.state === 'failed'
                const address = `${FORWARD_ADDRESS}:${local}`
                return (
                  <tr key={f.id} className="kube-cluster-row">
                    <td>
                      <span className="kube-forward-kind">{ref.kind}</span> {ref.name}
                    </td>
                    <td className="kube-forward-mono">
                      {f.state === 'connected' ? (
                        <button type="button" className="kube-forward-link" onClick={(ev) => onOpen(f, ev)}>
                          {address}
                        </button>
                      ) : (
                        address
                      )}
                    </td>
                    <td className="kube-forward-mono">{remoteName ? `${remote} ${remoteName}` : String(remote)}</td>
                    <td>
                      {displayContextName(ref.context).short}
                      {ref.namespace ? ` / ${ref.namespace}` : ''}
                    </td>
                    <td className={bad ? 'kube-forward-state bad' : 'kube-forward-state'}>
                      <span className={`kube-forward-dot ${f.state}`} aria-hidden="true" />{' '}
                      <span className="kube-forward-reason" title={stateText(f)}>
                        {stateText(f)}
                      </span>
                    </td>
                    <td className="kube-forward-mono">{run === null ? '' : runText(run)}</td>
                    <td className="kube-forward-actions">
                      {slot(f.state === 'connected', 'kube.forward.openBrowser', <Globe size={13} />, (ev) => onOpen(f, ev))}
                      {slot(isLive(f), 'kube.forward.stop', <Square size={13} />, () => onStop(f.id))}
                      {slot(!isLive(f), 'kube.forward.reconnect', <RotateCw size={13} />, () => onReconnect(f.id))}
                      {slot(!isLive(f), 'kube.forward.remove', <X size={13} />, () => onRemove(f.id))}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

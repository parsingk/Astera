import { useEffect, useId, useState } from 'react'
import { Lock, RefreshCw, RotateCcw } from 'lucide-react'
import type { MessageKey } from '../../../../../core/i18n'
import type { K8sObject } from '../../../../../core/kube/objects'
import type { ObjectRef, Read } from '../../../../../core/kube/cluster/types'
import { ageText } from '../../../../../core/kube/cluster/status'
import { displayContextName } from '../../../../../core/kube/contextName'
import { follow, useFollowingRead, useRereadTick, useWatchClient, type WatchState } from '../../../hooks/useClusterView'
import { errText } from '../../../hooks/useFileOps'
import { useI18n } from '../../../i18n/I18nProvider'
import { arrowStep } from '../../../lib/arrowStep'
import type { WatchClient } from '../../../lib/kubeWatchClient'
import { FileIcon } from '../../FileIcon'
import { EventsList, ReadView } from './ClusterDetail'
import { liveErrorText } from './ClusterView'
import { KubeYamlView } from './KubeYamlView'
import { useSecretReveal } from './useSecretReveal'

type TabView = 'yaml' | 'describe' | 'events'
const VIEWS: TabView[] = ['yaml', 'describe', 'events']
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** "Read 3s ago", ticking only while the tab shows. A component of its own, so the tick does not draw the YAML again. */
function ReadAgo({ at, visible }: { at: number; visible: boolean }): React.JSX.Element {
  const { t } = useI18n()
  const [now, setNow] = useState(at)
  useEffect(() => {
    if (!visible) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [visible])
  return <span className="kube-tab-read">{t('kube.cluster.readAgo', { ago: ageText(new Date(at).toISOString(), Math.max(now, at)) })}</span>
}

/** The tab's object for as long as it shows (K4), apart from React so its lifecycle can be tested: read once, then
 *  followed by a watch by name. Once the watch has spoken, a read answering later is older news and is dropped; a resync
 *  reads again, since a watch filtered by name says nothing of an object deleted meanwhile. Refused at the limit, the
 *  read is all there is: the object shows once and `state` says the tab is paused. `take(null)`: deleted. Returns the
 *  stop, for hide and unmount, after which nothing applies. */
export function followTabObject(o: {
  client: WatchClient
  get(ref: ObjectRef): Promise<Read<{ object: K8sObject | null }>>
  target: ObjectRef
  take(object: K8sObject | null): void
  /** The read's first line of stderr, or null once something better arrived. */
  fail(message: string | null): void
  state(s: WatchState): void
}): () => void {
  const { target } = o
  let alive = true
  let watched = false
  const read = (): void => {
    o.get(target).then(
      (r) => {
        if (!alive || watched) return
        if (!r.ok) return o.fail(r.message)
        o.fail(null)
        o.take(r.object)
      },
      (err) => {
        if (alive && !watched) o.fail(errText(err))
      }
    )
  }
  read()
  const stop = follow(
    o.client,
    { context: target.context, namespace: target.namespace, namespaced: target.namespace !== null, resource: target.resource, name: target.name },
    (m) => {
      if (m === 'resync') {
        watched = false
        read()
        return
      }
      watched = true
      o.fail(null)
      // By name, not uid: an object deleted and made again under the same name (a StatefulSet's Pod) is this tab's.
      o.take(m.type === 'DELETED' ? null : m.object)
    },
    o.state
  )
  return () => {
    alive = false
    stop()
  }
}

/** A cluster object in an editor tab, read-only in P1 (spec 4.6, board B): its YAML, describe or events under a toolbar
 *  that says where it lives, that it is read-only, when it was read and whether it is live. Mounted for the tab's life
 *  (PaneGrid's kube slots); it reads the object, then follows it through a watch only while the tab shows (K4), and
 *  reads afresh when it shows again. Edit, apply and compare come with P3 and are absent until then. */
export function KubeObjectTab({
  target,
  visible,
  initial
}: {
  target: ObjectRef
  visible: boolean
  /** Content shown before the first read answers: for tests, since a static render runs no effect to read it. */
  initial?: K8sObject
}): React.JSX.Element {
  const { t } = useI18n()
  const client = useWatchClient()
  const key = JSON.stringify(target)
  const [view, setView] = useState<TabView>('yaml')
  const ids = useId()
  const tabId = (v: TabView): string => `${ids}-tab-${v}`
  const panelId = `${ids}-panel`
  /** The object as last read or watched, and when; `deleted`: the cluster says it is gone, and `object` is its last
   *  content (null when it was never there). */
  const [shown, setShown] = useState<{ object: K8sObject | null; deleted: boolean; at: number } | null>(() =>
    initial !== undefined ? { object: initial, deleted: false, at: Date.now() } : null
  )
  /** The read's first line of stderr, until something better arrives. */
  const [failed, setFailed] = useState<string | null>(null)
  const [watch, setWatch] = useState<WatchState>('live')
  /** Bumped by refresh and retry: the read, the watch and the view's read start again. */
  const [gen, setGen] = useState(0)
  const [describe, setDescribe] = useState<Read<{ text: string }> | null>(null)
  const [events, setEvents] = useState<Read<{ events: K8sObject[] }> | null>(null)

  useEffect(() => {
    if (!visible) return
    return followTabObject({
      client,
      get: (ref) => window.api.kube.cluster.get(ref),
      target,
      take: (object) => setShown((prev) => ({ object: object ?? prev?.object ?? null, deleted: object === null, at: Date.now() })),
      fail: setFailed,
      state: setWatch
    })
    // `key` stands for `target`, which is a new object at every render of the grid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, key, gen, client])

  const object = shown?.object ?? null
  const uid = str(object?.metadata.uid) || null
  // Describe and events are one-shot reads: read again when the object changes, throttled, so they follow it too.
  const reread = useRereadTick(uid, str(object?.metadata.resourceVersion))

  useFollowingRead(
    visible && view === 'describe' ? { key: JSON.stringify([key, gen]), read: () => window.api.kube.cluster.describe(target), apply: setDescribe } : null,
    reread
  )

  useFollowingRead(
    visible && view === 'events' && uid !== null
      ? { key: JSON.stringify([key, gen, uid]), read: () => window.api.kube.cluster.events(target, uid), apply: setEvents }
      : null,
    reread
  )

  // Dropped with the tab (unmount), when the name comes back as another object (a new uid) and when the Secret changes.
  const reveal = useSecretReveal(object !== null ? target : null, uid, str(object?.metadata.resourceVersion))

  const gone = shown !== null && shown.deleted
  const state: 'live' | 'paused' | { error: string } = typeof watch === 'object' ? watch : watch === 'live' && visible ? 'live' : 'paused'
  const liveText = typeof state === 'object' ? liveErrorText(state.error, t) : t(state === 'live' ? 'kube.cluster.live' : 'kube.cluster.paused')
  const liveTone = typeof state === 'object' ? 'bad' : state === 'live' ? 'ok' : 'wait'
  const where = target.namespace !== null ? ` / ${target.namespace}` : ''

  return (
    <div className={'kube-tab' + (gone ? ' deleted' : '')}>
      <div className="kube-tab-bar">
        <span className="kube-pill" title={target.context + where}>
          <FileIcon id="kubernetes" tone="blue" />
          <span className="kube-pill-text">{displayContextName(target.context).short + where}</span>
        </span>
        <span className="kube-pill">
          <Lock size={11} aria-hidden="true" />
          {t('kube.cluster.readOnly')}
        </span>
        {shown !== null && <ReadAgo at={shown.at} visible={visible} />}
        <span className="kube-cluster-live" role="status">
          <span className={`kube-cluster-dot ${liveTone}`} aria-hidden="true" />
          {/* Paused at the limit says why in its tooltip (spec 4.2: "paused" with the reason). */}
          <span className="kube-cluster-live-text" title={watch === 'limit' ? t('kube.cluster.limit') : liveText}>
            {liveText}
          </span>
          {typeof state === 'object' && (
            <button type="button" className="kube-btn" title={t('kube.cluster.retry')} aria-label={t('kube.cluster.retry')} onClick={() => setGen((g) => g + 1)}>
              <RotateCcw size={13} />
            </button>
          )}
        </span>
        <div className="kube-segment-switch" role="tablist">
          {VIEWS.map((v) => (
            <button
              key={v}
              id={tabId(v)}
              type="button"
              role="tab"
              aria-selected={view === v}
              aria-controls={panelId}
              // One tab stop, the shown view; the arrows move between them (ARIA's tabs pattern).
              tabIndex={view === v ? 0 : -1}
              className={view === v ? 'kube-segment on' : 'kube-segment'}
              onClick={() => setView(v)}
              onKeyDown={(e) => {
                const to = arrowStep(VIEWS, view, e.key)
                if (to === null) return
                e.preventDefault()
                setView(to)
                document.getElementById(tabId(to))?.focus()
              }}
            >
              {t(`kube.cluster.tab.${v}` as MessageKey)}
            </button>
          ))}
        </div>
        <button type="button" className="kube-btn" title={t('kube.cluster.refresh')} aria-label={t('kube.cluster.refresh')} onClick={() => setGen((g) => g + 1)}>
          <RefreshCw size={14} />
        </button>
      </div>
      {gone && <div className="kube-detail-deleted">{t(object !== null ? 'kube.cluster.deleted' : 'kube.cluster.notFound')}</div>}
      <div className="kube-tab-body" role="tabpanel" id={panelId} aria-labelledby={tabId(view)}>
        {object === null ? (
          gone ? null : failed !== null ? (
            <div className="kube-cluster-empty kube-detail-error">{failed}</div>
          ) : (
            <div className="kube-cluster-empty">{t('kube.cluster.loading')}</div>
          )
        ) : view === 'yaml' ? (
          <KubeYamlView object={object} kind={target.kind} reveal={reveal} />
        ) : view === 'describe' ? (
          <ReadView read={describe} render={(r) => <pre className="kube-detail-describe">{r.text}</pre>} />
        ) : (
          <ReadView read={events} render={(r) => <EventsList events={r.events} />} />
        )}
      </div>
    </div>
  )
}

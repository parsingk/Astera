import { useEffect, useId, useRef, useState } from 'react'
import { Check, GitCompare, Lock, Pencil, RefreshCw, RotateCcw, Undo2 } from 'lucide-react'
import type { MessageKey } from '../../../../../core/i18n'
import type { K8sObject } from '../../../../../core/kube/objects'
import type { EditBase, LiveOp, ManifestMatch, ObjectRef, Read } from '../../../../../core/kube/cluster/types'
import { ageText } from '../../../../../core/kube/cluster/status'
import { displayContextName } from '../../../../../core/kube/contextName'
import { follow, useFollowingRead, useRereadTick, useWatchClient, type WatchState } from '../../../hooks/useClusterView'
import { errText } from '../../../hooks/useFileOps'
import { useI18n } from '../../../i18n/I18nProvider'
import { arrowStep } from '../../../lib/arrowStep'
import { confirmModal } from '../../../lib/confirm'
import type { WatchClient } from '../../../lib/kubeWatchClient'
import { FileIcon } from '../../FileIcon'
import { EventsList, ReadView } from './ClusterDetail'
import { liveErrorText } from './ClusterView'
import { KubeYamlEditor } from './KubeYamlEditor'
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

/** What the app gives every kube tab: the confirmation dialog for a write, the dirty flag the tab's close asks about, the
 *  count of edit asks per tab id (the cluster view's menu bumps it after it opens the tab), and the project file that
 *  declares the object (`compareTarget`) with the diff against the cluster (`startCompare`). */
export interface KubeTabHost {
  startWrite(op: LiveOp, onWritten: () => void): void
  setDirty(tabId: string, dirty: boolean): void
  editAsks: Record<string, number>
  compareTarget(ref: ObjectRef): Promise<ManifestMatch>
  /** Asks again at click time and opens the compare only while the file still declares this object for the tab's own
   *  target; answers the fresh match either way so the tab shows it. */
  startCompare(ref: ObjectRef, file: string): Promise<ManifestMatch>
  /** Changes with the project the compare is asked against, so a tab asks again when the project does. */
  compareKey: string
}

/** What a compare answer is for: the object (its uid), the target and the project. A change asks again. */
export function compareAskKey(uid: string | null, targetKey: string, project: string, visible = true): string {
  return JSON.stringify([uid, targetKey, project, visible])
}

/** Applies a click-time answer only while the ask key is still the one the click was made under. */
export function applyIfCurrent(keyAtClick: string, currentKey: () => string, apply: (m: ManifestMatch) => void, m: ManifestMatch): void {
  if (currentKey() === keyAtClick) apply(m)
}

/** The click-time rule: the compare opens only when the fresh answer is still `same` for the file the button was drawn for. */
export function compareAtClick(fresh: ManifestMatch, file: string): { open: boolean; match: ManifestMatch } {
  return { open: fresh.state === 'same' && fresh.file === file, match: fresh }
}

/** Asks which project file declares the object. A failed ask counts as none, and an answer arriving after the returned
 *  stop is dropped (the tab moved on to another object or went). */
export function askCompare(o: { ask(): Promise<ManifestMatch>; apply(m: ManifestMatch): void }): () => void {
  let alive = true
  // The last answer belongs to what was asked before: no icon until this one arrives.
  o.apply({ state: 'none' })
  o.ask().then(
    (m) => alive && o.apply(m),
    () => alive && o.apply({ state: 'none' })
  )
  return () => {
    alive = false
  }
}

/** Apply: opens the replace dialog with the edit's text and the base it started from. `onWritten` ends edit mode. */
export function applyEdit(host: KubeTabHost, target: ObjectRef, edit: { text: string; base: EditBase }, onWritten: () => void): void {
  host.startWrite({ verb: 'replace', ref: target, text: edit.text, base: edit.base }, onWritten)
}

/** Apply with the editor's current text, which differs from the start text once the person has typed. */
export function applyCurrentEdit(host: KubeTabHost, target: ObjectRef, start: { text: string; base: EditBase }, current: string, onWritten: () => void): void {
  applyEdit(host, target, { text: current, base: start.base }, onWritten)
}

/** The live chip's state: nothing is watched while editing (or hidden), so it is paused then. */
export function watchChip(watch: WatchState, visible: boolean, editing: boolean): 'live' | 'paused' | { error: string } {
  if (editing) return 'paused'
  return typeof watch === 'object' ? watch : watch === 'live' && visible ? 'live' : 'paused'
}

/** What a bumped edit ask does: a Secret whose values are not shown stays read-only and says why. */
export function editAskOutcome(kind: string, valuesShown: boolean, editing: boolean): 'start' | 'revealFirst' | 'ignore' {
  if (editing) return 'ignore'
  return kind === 'Secret' && !valuesShown ? 'revealFirst' : 'start'
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

/** A cluster object in an editor tab (spec 4.6, board B): its YAML, describe or events under a toolbar that says where it
 *  lives, that it is read-only, when it was read and whether it is live. Mounted for the tab's life (PaneGrid's kube
 *  slots); it reads the object, then follows it through a watch only while the tab shows (K4), and reads afresh when it
 *  shows again. Edit (P3) swaps the YAML for an editor on the text `editBase` answered: the watch stops meanwhile, the
 *  text is dirty while it differs from that start text, and apply goes through the write dialog. Compare asks which project file declares the object and diffs it. */
export function KubeObjectTab({
  target,
  visible,
  tabId: id,
  host,
  initial,
  initialEdit,
  initialMatch
}: {
  target: ObjectRef
  visible: boolean
  /** This tab's id, the key of `host.editAsks` and of the dirty flag. */
  tabId: string
  host: KubeTabHost
  /** Content shown before the first read answers: for tests, since a static render runs no effect to read it. */
  initial?: K8sObject
  /** Edit mode on entry: for tests, as `initial` is. */
  initialEdit?: { text: string; base: EditBase }
  /** The project file match on entry: for tests, as `initial` is. */
  initialMatch?: ManifestMatch
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

  /** The edit in progress: what `editBase` answered, which is also the baseline its dirtiness is measured from. */
  const [edit, setEdit] = useState<{ text: string; base: EditBase } | null>(initialEdit ?? null)
  const editing = edit !== null
  /** The editor's current text; the editor keeps the text itself, so a keystroke renders only when dirtiness flips. */
  const editText = useRef(initialEdit?.text ?? '')
  const [dirty, setDirty] = useState(false)
  const [editFailed, setEditFailed] = useState<string | null>(null)
  const [revealFirst, setRevealFirst] = useState(false)
  const asking = useRef(false)
  // The app's host is read through a ref, so a new host object never re-runs the effects below (their cleanup would
  // clear the dirty flag again); the flag is cleared only when the tab goes.
  const hostRef = useRef(host)
  hostRef.current = host

  useEffect(() => {
    // The watch stays off while editing: a changed object would otherwise move under the text being typed.
    if (!visible || editing) return
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
  }, [visible, key, gen, client, editing])

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

  // The project file that declares this object, asked on mount, when the name comes back as another object, when the
  // project changes and when the tab shows again (the folder's target may have changed meanwhile).
  const [match, setMatch] = useState<ManifestMatch>(initialMatch ?? { state: 'none' })
  const askKey = compareAskKey(uid, key, host.compareKey, visible)
  const askKeyRef = useRef(askKey)
  askKeyRef.current = askKey
  useEffect(
    () => (visible ? askCompare({ ask: () => hostRef.current.compareTarget(target), apply: setMatch }) : undefined),
    // `key` stands for `target`, as above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [askKey]
  )

  // Dropped with the tab (unmount), when the name comes back as another object (a new uid) and when the Secret changes.
  const reveal = useSecretReveal(object !== null ? target : null, uid, str(object?.metadata.resourceVersion))

  const isSecret = target.kind === 'Secret'
  const canEdit = object !== null && shown?.deleted !== true && (!isSecret || (reveal !== null && reveal.values !== null))

  /** Whether the Secret's values are shown right now, for an answer that arrives later (`editBase` in flight). */
  const valuesShown = useRef(false)
  valuesShown.current = reveal !== null && reveal.values !== null

  useEffect(() => {
    hostRef.current.setDirty(id, dirty)
  }, [dirty, id])
  useEffect(() => () => hostRef.current.setDirty(id, false), [id])
  // The note is answered once the values are shown; a failure line belongs to the object it was for.
  useEffect(() => {
    if (valuesShown.current) setRevealFirst(false)
  }, [reveal?.values])
  useEffect(() => setEditFailed(null), [uid])

  const startEdit = (): void => {
    if (asking.current) return
    asking.current = true
    setEditFailed(null)
    setRevealFirst(false)
    window.api.kube.cluster.editBase(target).then(
      (r) => {
        asking.current = false
        if (!r.ok) return setEditFailed(r.message)
        // The reveal can be dropped while this was in flight (the Secret changed): values never shown never open.
        if (isSecret && !valuesShown.current) return setRevealFirst(true)
        editText.current = r.text
        setDirty(false)
        setEdit({ text: r.text, base: r.base })
      },
      (err) => {
        asking.current = false
        setEditFailed(errText(err))
      }
    )
  }
  /** Ends edit mode: the watch starts again and reads afresh. */
  const endEdit = (): void => {
    setEdit(null)
    setDirty(false)
    setGen((g) => g + 1)
  }
  const discard = async (): Promise<void> => {
    if (edit !== null && editText.current !== edit.text) {
      const ok = await confirmModal({
        title: t('kube.edit.discardTitle'),
        body: t('kube.edit.discardBody', { name: target.name }),
        confirmLabel: t('common.confirm')
      })
      if (!ok) return
    }
    endEdit()
  }

  // The menu's edit: a count bumped after the tab opened. A Secret that is not shown stays read-only and says why.
  const seenAsks = useRef(0)
  const ask = host.editAsks[id] ?? 0
  useEffect(() => {
    if (ask <= seenAsks.current) return
    seenAsks.current = ask
    const outcome = editAskOutcome(target.kind, valuesShown.current, editing)
    if (outcome === 'revealFirst') return setRevealFirst(true)
    if (outcome === 'start') startEdit()
    // Only a new count asks; the rest is read when it does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask])

  const gone = shown !== null && shown.deleted
  const state = watchChip(watch, visible, editing)
  const liveText = typeof state === 'object' ? liveErrorText(state.error, t) : t(state === 'live' ? 'kube.cluster.live' : 'kube.cluster.paused')
  const liveTone = typeof state === 'object' ? 'bad' : state === 'live' ? 'ok' : 'wait'
  const where = target.namespace !== null ? ` / ${target.namespace}` : ''
  const elsewhere =
    match.state === 'other'
      ? t('kube.edit.compareElsewhere', {
          file: match.file,
          target: match.context + (match.namespace !== null ? ` / ${match.namespace}` : '')
        })
      : ''
  const compare =
    match.state === 'same' ? (
      <button type="button" className="kube-btn" title={t('kube.edit.compare')} aria-label={t('kube.edit.compare')} onClick={() => {
          const keyAtClick = askKeyRef.current
          void host.startCompare(target, match.file).then((m) => applyIfCurrent(keyAtClick, () => askKeyRef.current, setMatch, m), () => undefined)
        }}>
        <GitCompare size={14} />
      </button>
    ) : match.state === 'other' ? (
      <span
        className="kube-btn kube-btn-muted"
        role="img"
        title={elsewhere}
        aria-label={elsewhere}
      >
        <GitCompare size={14} />
      </span>
    ) : null

  return (
    <div className={'kube-tab' + (gone ? ' deleted' : '')}>
      <div className="kube-tab-bar">
        <span className="kube-pill" title={target.context + where}>
          <FileIcon id="kubernetes" tone="blue" />
          <span className="kube-pill-text">{displayContextName(target.context).short + where}</span>
        </span>
        <span className="kube-pill">
          {editing ? <Pencil size={11} aria-hidden="true" /> : <Lock size={11} aria-hidden="true" />}
          {t(editing ? 'kube.edit.editing' : 'kube.cluster.readOnly')}
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
        {editing ? (
          <>
            <button
              type="button"
              className="kube-btn"
              title={t('kube.edit.apply')}
              aria-label={t('kube.edit.apply')}
              onClick={() => edit !== null && applyCurrentEdit(host, target, edit, editText.current, endEdit)}
            >
              <Check size={14} />
            </button>
            <button type="button" className="kube-btn" title={t('kube.edit.discard')} aria-label={t('kube.edit.discard')} onClick={() => void discard()}>
              <Undo2 size={14} />
            </button>
            {compare}
          </>
        ) : (
          <>
            <button
              type="button"
              className="kube-btn"
              title={isSecret && object !== null && !gone && !canEdit ? t('kube.edit.revealFirst') : t('kube.edit.start')}
              aria-label={t('kube.edit.start')}
              disabled={!canEdit}
              onClick={startEdit}
            >
              <Pencil size={14} />
            </button>
            <button type="button" className="kube-btn" title={t('kube.cluster.refresh')} aria-label={t('kube.cluster.refresh')} onClick={() => setGen((g) => g + 1)}>
              <RefreshCw size={14} />
            </button>
            {compare}
          </>
        )}
      </div>
      {editFailed !== null && (
        <div className="kube-yaml-note kube-yaml-error" role="alert">
          {editFailed}
        </div>
      )}
      {revealFirst && <div className="kube-yaml-note">{t('kube.edit.revealFirst')}</div>}
      {gone && <div className="kube-detail-deleted">{t(object !== null ? 'kube.cluster.deleted' : 'kube.cluster.notFound')}</div>}
      <div className="kube-tab-body" role="tabpanel" id={panelId} aria-labelledby={tabId(view)}>
        {/* Mounted while editing whichever view shows, so the text survives a look at describe or events. */}
        {edit !== null && (
          <div style={view === 'yaml' ? { height: '100%' } : { display: 'none' }}>
            <KubeYamlEditor
              initial={edit.text}
              onChange={(text) => {
                editText.current = text
                setDirty(text !== edit.text)
              }}
            />
          </div>
        )}
        {edit !== null && view === 'yaml' ? null : object === null ? (
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

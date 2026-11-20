import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Clock, Download, Eraser, Search, TextWrap } from 'lucide-react'
import type { K8sObject } from '../../../../../core/kube/objects'
import type { ObjectRef } from '../../../../../core/kube/cluster/types'
import {
  ansiSpans,
  containersOf,
  exitLine,
  filterLines,
  logFileName,
  previousByDefault,
  restartCountOf,
  stampText,
  visibleText,
  type LogLine,
  type Span
} from '../../../../../core/kube/cluster/logs'
import { displayContextName } from '../../../../../core/kube/contextName'
import { useKubeLogStream } from '../../../hooks/useKubeLogStream'
import { errText } from '../../../hooks/useFileOps'
import { useI18n } from '../../../i18n/I18nProvider'
import { toast } from '../../../lib/toast'
import { liveErrorText } from '../cluster/ClusterView'

/** A line's height when lines do not wrap. The window counts in it even when they do. */
export const LINE_HEIGHT = 20
/** Lines drawn beyond the viewport on each side, so a fast scroll does not show blanks. */
const OVERSCAN = 10
const DEFAULT_VIEWPORT = 400
/** This close to the end still counts as the bottom: a zoomed page scrolls in fractions of a pixel. */
const BOTTOM_SLACK = 4
/** The waits between Pod reads after a stream ends, until the exit shows. */
const EXIT_RETRY_MS = [1000, 2000, 4000]

/** The lines to draw, from `first` up to `last`: the end of the list while the view keeps to the bottom, else the
 *  lines around the scroll position, counted at LINE_HEIGHT a line. Wrapped lines are taller than that count, so near
 *  the end the window stays the end's: counted from the scroll position it would start past the lines in view, the
 *  list would shrink under the person and the box would throw them back to the bottom. */
export function lineWindow(count: number, top: number, height: number, atEnd: boolean): { first: number; last: number } {
  const size = Math.ceil(height / LINE_HEIGHT) + 2 * OVERSCAN
  const endFirst = Math.max(0, count - size)
  const first = atEnd ? endFirst : Math.max(0, Math.min(endFirst, Math.floor(top / LINE_HEIGHT) - OVERSCAN))
  return { first, last: Math.min(count, first + size) }
}

function spanStyle(s: Span): React.CSSProperties | undefined {
  if (s.fg === undefined && s.bg === undefined && !s.bold && !s.dim && !s.italic && !s.underline) return undefined
  return {
    color: s.fg,
    background: s.bg,
    fontWeight: s.bold ? 600 : undefined,
    opacity: s.dim ? 0.6 : undefined,
    fontStyle: s.italic ? 'italic' : undefined,
    textDecoration: s.underline ? 'underline' : undefined
  }
}

/** A line as the person reads it, for the saved file: the time stamp as shown, then the text without colour codes. */
const plainLine = (l: LogLine, timestamps: boolean): string => (timestamps && l.ts !== null ? `${stampText(l.ts)} ` : '') + visibleText(l.text)

/** A Pod's logs in their bottom tab (spec 4.8, board E): the toolbar, then the lines, drawn only around what is in
 *  view since a busy container keeps up to LOG_MAX_LINES. Mounted for the tab's life, its kubectl runs while the tab is
 *  open, shown or not, as a terminal does; `visible` only puts the scroll position back when the tab shows again. */
export function KubeLogView({
  pod,
  target,
  initial,
  visible
}: {
  /** The Pod as the opener knew it: its containers, and the exit code once the stream ends. */
  pod: K8sObject | null
  target: ObjectRef
  /** `filter`: for tests, since a static render cannot type into the field. */
  initial: { container: string; previous: boolean; filter?: string }
  visible: boolean
}): React.JSX.Element {
  const { t } = useI18n()
  const targetKey = JSON.stringify(target)
  const [container, setContainer] = useState(initial.container)
  const [previous, setPrevious] = useState(initial.previous)
  const [follow, setFollow] = useState(true)
  const [filter, setFilter] = useState(initial.filter ?? '')
  const [timestamps, setTimestamps] = useState(true)
  const [wrap, setWrap] = useState(false)
  /** The Pod as last read: its containers, and once the stream ends its exit. The tab knows only where the Pod lives,
   *  so the view reads it; `pod` shows until the first read answers. */
  const [fresh, setFresh] = useState<K8sObject | null>(null)
  const podNow = fresh ?? pod
  const stream = useKubeLogStream(target, { container, previous, follow })
  const { buffer, state } = stream

  /** Reads asked, and the last one applied: an answer older than one already applied is dropped, so a slow read cannot
   *  put an older Pod back. */
  const reads = useRef({ asked: 0, applied: 0 })
  const readPod = (alive: () => boolean): Promise<K8sObject | null> => {
    const seq = ++reads.current.asked
    return window.api.kube.cluster.get(JSON.parse(targetKey) as ObjectRef).then(
      (r) => {
        if (!alive() || !r.ok || r.object === null || seq < reads.current.applied) return null
        reads.current.applied = seq
        setFresh(r.object)
        return r.object
      },
      // Unread, the picker keeps what it has and the closing line says only that the stream ended.
      () => null
    )
  }

  useEffect(() => {
    let alive = true
    setFresh(null)
    void readPod(() => alive)
    return () => {
      alive = false
    }
    // `readPod` is this render's, for this `targetKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey])

  /** The container's restart count when its stream started (see exitLine); null while no Pod is known. */
  const streamKey = JSON.stringify([targetKey, container, previous, follow])
  const startRestarts = useRef<{ key: string; count: number | null }>({ key: '', count: null })
  useEffect(() => {
    const count = podNow !== null ? restartCountOf(podNow, container) : null
    if (startRestarts.current.key !== streamKey) startRestarts.current = { key: streamKey, count }
    // The first read can answer after the stream started; until the stream ends, its count is still the start's.
    else if (startRestarts.current.count === null && state !== 'ended') startRestarts.current.count = count
  }, [streamKey, podNow, state])

  // kubectl ends before the kubelet writes the exit: read the Pod now, then after 1, 2 and 4 s until the exit shows.
  // Previous logs are of a container that ended long ago: one read.
  useEffect(() => {
    if (state !== 'ended') return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const attempt = (k: number): void => {
      void readPod(() => alive).then((p) => {
        if (!alive || previous || k >= EXIT_RETRY_MS.length) return
        if (p !== null && exitLine(p, container, false, startRestarts.current.count) !== null) return
        timer = setTimeout(() => attempt(k + 1), EXIT_RETRY_MS[k])
      })
    }
    attempt(0)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [state, previous, container, targetKey])

  const rows = useMemo(() => (filter === '' ? buffer.lines : filterLines(buffer.lines, filter)), [buffer.lines, filter])

  const box = useRef<HTMLDivElement>(null)
  /** `pinned`: the view keeps to the bottom, as new lines come; scrolling up lets go until the person comes back down. */
  const [scroll, setScroll] = useState({ height: DEFAULT_VIEWPORT, top: 0, pinned: true })
  /** The exact scroll position, to put back when the tab shows again: under display:none the box forgets it. */
  const lastTop = useRef(0)
  const wasVisible = useRef(visible)
  const pin = (): void => setScroll((s) => (s.pinned ? s : { ...s, pinned: true }))

  // The opener asks again for this tab (previous logs of the same container): the tab follows what it asks, and the
  // new stream starts at its end.
  useEffect(() => {
    setContainer(initial.container)
    setPrevious(initial.previous)
    pin()
  }, [initial.container, initial.previous])

  useEffect(() => {
    const el = box.current
    if (el === null) return
    // A hidden tab measures 0: keep the last height for when it shows again.
    const measure = (): void => setScroll((s) => (el.clientHeight === 0 || s.height === el.clientHeight ? s : { ...s, height: el.clientHeight }))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // After every render, before it paints: kept to the bottom, the end stays in view however the lines changed; shown
  // again after hiding, the box gets back where it was.
  useLayoutEffect(() => {
    const el = box.current
    const shownAgain = visible && !wasVisible.current
    wasVisible.current = visible
    if (el === null || !visible) return
    if (scroll.pinned) el.scrollTop = el.scrollHeight
    else if (shownAgain) el.scrollTop = lastTop.current
  })

  const { first, last } = lineWindow(rows.length, scroll.top, scroll.height, scroll.pinned)
  const exit = state === 'ended' && podNow !== null ? exitLine(podNow, container, previous, startRestarts.current.count) : null
  const choices = podNow !== null ? containersOf(podNow) : []
  if (!choices.some((c) => c.name === container)) choices.unshift({ name: container, init: false })
  const where = target.namespace !== null ? ` / ${target.namespace}` : ''

  const pickContainer = (name: string): void => {
    setContainer(name)
    // Previous follows the container picked: on for one in CrashLoopBackOff, where the reason is (spec 4.8).
    setPrevious(podNow !== null && previousByDefault(podNow, name))
    pin()
  }
  const save = async (): Promise<void> => {
    const text = rows.map((l) => plainLine(l, timestamps) + '\n').join('')
    try {
      const r = await window.api.kube.logs.save(logFileName(target.name, container, previous), text)
      if (r.saved) toast.success(t('kube.logs.saved', { path: r.path ?? '' }))
      else if (r.error !== undefined) toast.error(t('kube.logs.saveFailed', { detail: r.error }))
    } catch (err) {
      toast.error(t('kube.logs.saveFailed', { detail: errText(err) }))
    }
  }
  const iconButton = (label: string, icon: React.ReactNode, onClick: () => void, extra: { pressed?: boolean; disabled?: boolean } = {}): React.JSX.Element => (
    <button
      type="button"
      className={'kube-btn' + (extra.pressed ? ' on' : '')}
      title={label}
      aria-label={label}
      aria-pressed={extra.pressed}
      disabled={extra.disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  )

  return (
    <div className="kube-logs">
      <div className="kube-logs-bar">
        <select
          className="kube-pill"
          title={t('kube.logs.container')}
          aria-label={t('kube.logs.container')}
          value={container}
          onChange={(e) => pickContainer(e.target.value)}
        >
          {choices.map((c) => (
            <option key={c.name} value={c.name}>
              {c.init ? t('kube.logs.initContainer', { name: c.name }) : c.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={'kube-segment' + (previous ? ' on' : '')}
          title={t('kube.logs.previousTitle')}
          aria-label={t('kube.logs.previous')}
          aria-pressed={previous}
          onClick={() => {
            setPrevious(!previous)
            pin()
          }}
        >
          {t('kube.logs.previous')}
        </button>
        {/* Previous logs are finished: there is nothing to follow (spec 4.8). */}
        <button
          type="button"
          className={'kube-segment' + (follow && !previous ? ' on' : '')}
          title={t('kube.logs.follow')}
          aria-label={t('kube.logs.follow')}
          aria-pressed={follow && !previous}
          disabled={previous}
          onClick={() => {
            setFollow(!follow)
            pin()
          }}
        >
          {t('kube.logs.follow')}
        </button>
        <label className="kube-cluster-filter">
          <Search size={12} aria-hidden="true" />
          <input value={filter} placeholder={t('kube.logs.filter')} aria-label={t('kube.logs.filter')} onChange={(e) => setFilter(e.target.value)} />
        </label>
        <span className="kube-pill kube-logs-where" title={target.context + where}>
          <span className="kube-pill-text">{displayContextName(target.context).short + where}</span>
        </span>
        {iconButton(t('kube.logs.timestamps'), <Clock size={14} />, () => setTimestamps(!timestamps), { pressed: timestamps })}
        {iconButton(t('kube.logs.wrap'), <TextWrap size={14} />, () => setWrap(!wrap), { pressed: wrap })}
        {iconButton(t('kube.logs.save'), <Download size={14} />, () => void save(), { disabled: rows.length === 0 })}
        {iconButton(
          t('kube.logs.clear'),
          <Eraser size={14} />,
          () => {
            stream.clear()
            pin()
          },
          { disabled: buffer.lines.length === 0 }
        )}
      </div>
      {buffer.dropped > 0 && (
        <div className="kube-logs-dropped" role="status">
          {t('kube.logs.dropped', { count: buffer.dropped })}
        </div>
      )}
      <div
        ref={box}
        className={'kube-logs-body' + (wrap ? ' wrap' : '')}
        role="log"
        aria-label={t('kube.logs.lines', { container })}
        onScroll={(e) => {
          const el = e.currentTarget
          // A hidden box says nothing of where the person was.
          if (el.clientHeight === 0) return
          lastTop.current = el.scrollTop
          const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_SLACK
          // The top counts whole lines, so a scroll inside one line draws nothing again.
          const top = Math.floor(el.scrollTop / LINE_HEIGHT) * LINE_HEIGHT
          setScroll((s) => (atBottom ? (s.pinned ? s : { ...s, pinned: true }) : !s.pinned && s.top === top ? s : { ...s, top, pinned: false }))
        }}
      >
        {first > 0 && <div aria-hidden="true" style={{ height: first * LINE_HEIGHT }} />}
        {rows.slice(first, last).map((l) => (
          <div key={l.n} className="kube-logs-line" style={wrap ? undefined : { height: LINE_HEIGHT }}>
            {timestamps && <span className="kube-logs-ts">{l.ts !== null ? stampText(l.ts) : ''}</span>}
            <span className="kube-logs-text">
              {ansiSpans(l.text).map((s, i) => (
                <span key={i} style={spanStyle(s)}>
                  {s.text}
                </span>
              ))}
            </span>
          </div>
        ))}
        {rows.length > last && <div aria-hidden="true" style={{ height: (rows.length - last) * LINE_HEIGHT }} />}
        {state === 'starting' && buffer.lines.length === 0 && <div className="kube-logs-note">{t('kube.cluster.loading')}</div>}
        {typeof state === 'object' && <div className="kube-logs-error">{liveErrorText(state.error, t)}</div>}
        {state === 'ended' && (
          <div className="kube-logs-end">
            {exit !== null ? (
              <>
                <span>{t('kube.logs.ended', { code: exit.code })}</span>
                {/* finishedAt counts whole seconds. */}
                {exit.at !== null && <span className="kube-logs-end-time">{stampText(exit.at).replace(/\.000$/, '')}</span>}
              </>
            ) : (
              <span>{t('kube.logs.streamEnded')}</span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

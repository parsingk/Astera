import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../../../i18n/I18nProvider'
import { DETAIL_KEY, DETAIL_MIN, DETAIL_STEP, clampDetailWidth, detailBounds, readDetailWidth } from '../../../lib/kubeDetailWidth'

const saved = (): number => {
  try {
    return readDetailWidth(localStorage.getItem(DETAIL_KEY))
  } catch {
    return readDetailWidth(null)
  }
}

/** The detail column with a drag handle on its left edge. The sidebar's resizer (App.tsx) is the pattern: pointer
 *  listeners on window rather than pointer capture, the pointer that started the drag the only one heard, the width
 *  written to the element while dragging and to React state and localStorage once, on release. `bodyRef` is the grid the
 *  column sits in: its width and its first child (the kind tree) are what the clamp needs. */
export function DetailColumn({ bodyRef, children }: { bodyRef: React.RefObject<HTMLDivElement | null>; children: React.ReactNode }): React.JSX.Element {
  const { t } = useI18n()
  const [width, setWidth] = useState<number>(saved)
  const colRef = useRef<HTMLDivElement>(null)
  const dragCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => dragCleanup.current?.(), [])

  const clamp = (want: number): number => {
    const body = bodyRef.current
    const tree = body?.firstElementChild
    if (!body || !tree) return want
    return clampDetailWidth(want, body.getBoundingClientRect().width, tree.getBoundingClientRect().width)
  }
  const commit = (w: number): void => {
    setWidth(w)
    try {
      localStorage.setItem(DETAIL_KEY, String(w))
    } catch {
      // the width just is not remembered
    }
  }

  // A window made narrower after the width was chosen would leave the table no room: show the width that fits, keep
  // the one chosen.
  const [shown, setShown] = useState(width)
  const [max, setMax] = useState<number | undefined>(undefined)
  useEffect(() => {
    const body = bodyRef.current
    const fit = (): void => {
      setShown(clamp(width))
      const tree = body?.firstElementChild
      if (body && tree) setMax(detailBounds(body.getBoundingClientRect().width, tree.getBoundingClientRect().width).max)
    }
    fit()
    if (!body || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(fit)
    ro.observe(body)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width])

  const onPointerDown = (e: React.PointerEvent): void => {
    // Only the primary button drags; a right or middle press must not start one.
    if (e.button !== 0) return
    e.preventDefault()
    if (dragCleanup.current) return
    const startId = e.pointerId
    const startX = e.clientX
    const startW = colRef.current?.getBoundingClientRect().width ?? shown
    let latestX = startX
    let rafId = 0
    // The handle is on the column's left edge, so dragging left widens it.
    const target = (): number => clamp(startW - (latestX - startX))
    const apply = (): void => {
      rafId = 0
      if (colRef.current) colRef.current.style.width = `${target()}px`
    }
    const cleanup = (): void => {
      if (rafId) cancelAnimationFrame(rafId)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.classList.remove('resizing')
      dragCleanup.current = null
    }
    // A move with no button held means the release was missed (the sidebar resizer's reason): end the drag there.
    const onMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== startId) return
      if ((ev.buttons & 1) === 0) return onUp(ev)
      latestX = ev.clientX
      if (!rafId) rafId = requestAnimationFrame(apply)
    }
    const onUp = (ev: PointerEvent): void => {
      if (ev.pointerId !== startId) return
      const w = target()
      cleanup()
      commit(w)
    }
    dragCleanup.current = cleanup
    document.body.classList.add('resizing')
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // Left moves the handle left, which widens the column.
    const delta = e.key === 'ArrowLeft' ? DETAIL_STEP : e.key === 'ArrowRight' ? -DETAIL_STEP : 0
    if (delta === 0) return
    e.preventDefault()
    commit(clamp(shown + delta))
  }

  return (
    <div className="kube-detail-col" ref={colRef} style={{ width: shown }}>
      <div
        className="kube-detail-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('kube.cluster.resizeDetail')}
        aria-valuemin={DETAIL_MIN}
        aria-valuemax={max}
        aria-valuenow={shown}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
      />
      {children}
    </div>
  )
}

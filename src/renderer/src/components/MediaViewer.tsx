// The media viewer tab: a video an agent rendered or an image it made, played or shown where the
// session is, instead of in File Explorer. The bytes come through astera-media:// (main/media/
// protocol.ts), which serves only files a link resolved for (main/media/allowlist.ts), with Range so
// the <video> can seek. The bar names the file and its folder and offers the two ways out of the app.
import { useEffect, useRef, useState } from 'react'
import { mediaKindOf, mediaUrl, mediaVersion, reloadStep, resumeAt, type MediaStat, type ReloadState } from '../../../core/files/media'
import { parentDir } from '../../../core/files/paths'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'

/** How often a viewer on screen re-reads the file's stat. An agent rewriting a clip while the person
 *  watches it in a split is the case this is for; one stat every few seconds is nothing next to a
 *  video decode, and it stops the moment the viewer is hidden. */
const POLL_MS = 3000

/** The viewer stays mounted for its tab's life (PaneGrid keeps one slot per media tab, hidden while
 *  inactive), so a video keeps its element and its place across tab switches. `active` is whether it
 *  is on screen: turning false pauses the video, so a hidden tab makes no sound.
 *
 *  A file regenerated under the same name reloads. The stat is re-read on mount, when the tab comes
 *  back on screen, when the window regains focus, when the person clicks a link to the same file
 *  again (`nonce`, bumped by App's openMedia), and every POLL_MS while on screen. A new mtime or
 *  size is loaded once two checks in a row agree on it (reloadStep) — a clip rewritten in place is
 *  not shown half-written — and then gives the URL a new version, so the element loads the new
 *  bytes instead of the cached ones; the play position is carried over when the new file still runs
 *  that long. Every trigger goes through the same rule, so a second click on a link to a file that
 *  just changed reloads on the next check, about POLL_MS later. */
export function MediaViewer({ path, active, nonce }: { path: string; active: boolean; nonce: number }): React.JSX.Element {
  const { t } = useI18n()
  const kind = mediaKindOf(path)
  // undefined while the first stat is in flight, null when the file cannot be opened
  const [stat, setStat] = useState<MediaStat | null | undefined>(undefined)
  // The element itself failed (a codec Chromium cannot play, a truncated file) — distinct from a
  // stat failure, but said the same way: the person can still open it in the default app.
  const [broken, setBroken] = useState(false)
  // What is loaded, what change is waiting for a second look, and the newest answer applied
  // (reloadStep in core/files/media.ts has the rules)
  const reloadRef = useRef<ReloadState>({ loaded: undefined, pending: undefined, lastSeq: 0 })
  const seqRef = useRef(0)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  // Where the old element was when a reload replaced it, applied once the new one knows its duration.
  // Taken from the element that was on screen through the whole rewrite — a change is not loaded until
  // it is stable, so no half-written clip ever stands in between — and kept across a "gone" spell, so
  // a file deleted and written again still resumes where it was.
  const resumeRef = useRef<{ time: number; playing: boolean } | null>(null)

  const activeRef = useRef(active)
  activeRef.current = active
  const checkRef = useRef<() => void>(() => {})
  checkRef.current = () => {
    const seq = ++seqRef.current
    const apply = (next: MediaStat | null): void => {
      const r = reloadStep(reloadRef.current, seq, next)
      reloadRef.current = r.state
      if (r.action === 'none') return
      const v = videoRef.current
      if (v) resumeRef.current = { time: v.currentTime, playing: !v.paused }
      if (r.action === 'gone') {
        setStat(null)
        return
      }
      setBroken(false)
      setStat(next)
    }
    void window.api.media.stat(path).then(apply, () => apply(null))
  }

  // Mount, a second click on the same link, and coming back on screen
  useEffect(() => {
    if (active) checkRef.current()
  }, [path, nonce, active])

  // On screen: poll, and re-check when the window comes back to the front. Hidden: pause and stop.
  useEffect(() => {
    if (!active) {
      videoRef.current?.pause()
      return
    }
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') checkRef.current()
    }, POLL_MS)
    const onFocus = (): void => checkRef.current()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [active])

  const name = path.split(/[\\/]/).pop() || t('media.tab.untitled')
  const folder = parentDir(path)
  // Our own words rather than the rejection's: an IPC error arrives wrapped in "Error invoking remote
  // method ...", which tells the person nothing they can act on
  const fail = (): void => {
    toast.error(t('media.error.cannotOpen'))
  }
  const src = stat ? mediaUrl(path, mediaVersion(stat)) : null

  return (
    <div className="media-viewer">
      <div className="media-viewer-bar">
        <span className="media-viewer-title" title={path}>
          {name}
        </span>
        <span className="media-viewer-folder" title={folder}>
          {folder}
        </span>
        <button type="button" className="media-viewer-btn" onClick={() => window.api.media.openExternal(path).catch(fail)}>
          {t('media.action.openExternal')}
        </button>
        <button type="button" className="media-viewer-btn" onClick={() => window.api.media.reveal(path).catch(fail)}>
          {t('media.action.reveal')}
        </button>
      </div>
      <div className="media-viewer-stage">
        {stat === null || broken || kind === null ? (
          <div className="media-viewer-empty">{t('media.error.cannotOpen')}</div>
        ) : src === null ? null : kind === 'video' ? (
          // key: a new version is a new element, so playback starts clean rather than seeking a
          // half-loaded old stream; the old position is carried over on loadedmetadata
          <video
            key={src}
            ref={videoRef}
            className="media-viewer-media"
            src={src}
            controls
            onLoadedMetadata={(e) => {
              const r = resumeRef.current
              resumeRef.current = null
              if (!r) return
              const el = e.currentTarget
              el.currentTime = resumeAt(r.time, el.duration)
              if (r.playing && activeRef.current) void el.play().catch(() => {})
            }}
            onError={() => setBroken(true)}
          />
        ) : (
          <img key={src} className="media-viewer-media" src={src} alt={name} draggable={false} onError={() => setBroken(true)} />
        )}
      </div>
    </div>
  )
}

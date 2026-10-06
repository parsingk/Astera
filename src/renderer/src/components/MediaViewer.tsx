// The media viewer tab: a video an agent rendered or an image it made, played or shown where the
// session is, instead of in File Explorer. The bytes come through astera-media:// (main/media/
// protocol.ts), which serves only files a link resolved for (main/media/allowlist.ts), with Range so
// the <video> can seek. The bar names the file and its folder and offers the two ways out of the app.
import { useEffect, useRef, useState } from 'react'
import { mediaChanged, mediaKindOf, mediaUrl, mediaVersion, resumeAt, type MediaStat } from '../../../core/files/media'
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
 *  size (mediaChanged) gives the URL a new version, so the element loads the new bytes instead of the
 *  cached ones; the play position is carried over when the new file still runs that long. */
export function MediaViewer({ path, active, nonce }: { path: string; active: boolean; nonce: number }): React.JSX.Element {
  const { t } = useI18n()
  const kind = mediaKindOf(path)
  // undefined while the first stat is in flight, null when the file cannot be opened
  const [stat, setStat] = useState<MediaStat | null | undefined>(undefined)
  // The element itself failed (a codec Chromium cannot play, a truncated file) — distinct from a
  // stat failure, but said the same way: the person can still open it in the default app.
  const [broken, setBroken] = useState(false)
  const statRef = useRef<MediaStat | null | undefined>(undefined)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  // Where the old element was when a reload replaced it, applied once the new one knows its duration
  const resumeRef = useRef<{ time: number; playing: boolean } | null>(null)

  const activeRef = useRef(active)
  activeRef.current = active
  const checkRef = useRef<() => void>(() => {})
  checkRef.current = () => {
    void window.api.media.stat(path).then(
      (next) => {
        const prev = statRef.current
        if (next === null) {
          statRef.current = null
          setStat(null)
          return
        }
        if (!mediaChanged(prev, next)) return
        const v = videoRef.current
        if (prev && v) resumeRef.current = { time: v.currentTime, playing: !v.paused }
        statRef.current = next
        setBroken(false)
        setStat(next)
      },
      () => {
        statRef.current = null
        setStat(null)
      }
    )
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

// The media viewer tab: a video an agent rendered or an image it made, played or shown where the
// session is, instead of in File Explorer. The bytes come through astera-media:// (main/media/
// protocol.ts), which serves only files a link resolved for (main/media/allowlist.ts), with Range so
// the <video> can seek. The bar names the file and its folder and offers the two ways out of the app.
import { useEffect, useState } from 'react'
import { mediaKindOf, mediaUrl } from '../../../core/files/media'
import { parentDir } from '../../../core/files/paths'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'

/** `version` is the file's mtime, and it is what makes a file regenerated under the same name show
 *  its new content: the URL changes with it, so the element reloads instead of keeping the old one.
 *  It is re-read on mount — the slot is drawn only while its tab is active (PaneGrid), so coming back
 *  to the tab is a mount — and when the window regains focus, which is when the person returns from
 *  wherever the file was remade. A watcher was the other option; this costs one stat per return and
 *  has nothing to leak or keep alive. */
export function MediaViewer({ path }: { path: string }): React.JSX.Element {
  const { t } = useI18n()
  const kind = mediaKindOf(path)
  // undefined while the first stat is in flight, null when the file cannot be opened
  const [version, setVersion] = useState<number | null | undefined>(undefined)
  // The element itself failed (a codec Chromium cannot play, a truncated file) — distinct from a
  // stat failure, but said the same way: the person can still open it in the default app.
  const [broken, setBroken] = useState(false)

  useEffect(() => {
    let alive = true
    const check = (): void => {
      void window.api.media.stat(path).then(
        (st) => {
          if (!alive) return
          setVersion((prev) => {
            const next = st ? st.mtimeMs : null
            if (next !== prev) setBroken(false)
            return next
          })
        },
        () => alive && setVersion(null)
      )
    }
    check()
    window.addEventListener('focus', check)
    return () => {
      alive = false
      window.removeEventListener('focus', check)
    }
  }, [path])

  const name = path.split(/[\\/]/).pop() || t('media.tab.untitled')
  const folder = parentDir(path)
  // Our own words rather than the rejection's: an IPC error arrives wrapped in "Error invoking remote
  // method ...", which tells the person nothing they can act on
  const fail = (): void => {
    toast.error(t('media.error.cannotOpen'))
  }
  const src = typeof version === 'number' ? mediaUrl(path, version) : null

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
        {version === null || broken || kind === null ? (
          <div className="media-viewer-empty">{t('media.error.cannotOpen')}</div>
        ) : src === null ? null : kind === 'video' ? (
          // key: a new version is a new element, so playback starts clean rather than seeking a
          // half-loaded old stream
          <video key={src} className="media-viewer-media" src={src} controls autoPlay={false} onError={() => setBroken(true)} />
        ) : (
          <img key={src} className="media-viewer-media" src={src} alt={name} draggable={false} onError={() => setBroken(true)} />
        )}
      </div>
    </div>
  )
}

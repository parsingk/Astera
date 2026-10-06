// What the media viewer tab plays or shows, and the URL it loads a file through. Pure, no node:
// imports — the renderer decides which tab a link opens with mediaKindOf, and main's protocol handler
// (main/media/protocol.ts) reads the same tables, so the two can never disagree on what is media.
import { own } from './imageMime'

export type MediaKind = 'video' | 'image'

/** Extension (lowercase, no dot) → kind and MIME. An allowlist, like imageMime's table and for the
 *  same reason: the protocol serves a file under this MIME, so nothing outside the table is guessed.
 *  svg is left out on purpose — it is a document that can carry script, and this viewer has no reason
 *  to load one through a privileged scheme. */
const MEDIA: Record<string, { kind: MediaKind; mime: string }> = {
  mp4: { kind: 'video', mime: 'video/mp4' },
  mov: { kind: 'video', mime: 'video/quicktime' },
  webm: { kind: 'video', mime: 'video/webm' },
  m4v: { kind: 'video', mime: 'video/x-m4v' },
  png: { kind: 'image', mime: 'image/png' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  webp: { kind: 'image', mime: 'image/webp' },
  gif: { kind: 'image', mime: 'image/gif' }
}

/** The extension of the last path segment, lowercase. '' for a name with no dot or a dot file
 *  (`.mp4` alone is a hidden file's name, not an mp4). Both separators count: a Windows path reaches
 *  this in the renderer, where there is no node:path to ask. */
function extOf(p: string): string {
  const name = p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** 'video' or 'image' for a path the viewer handles, null for everything else. */
export function mediaKindOf(p: string): MediaKind | null {
  return own(MEDIA, extOf(p))?.kind ?? null
}

/** The MIME type the protocol answers with, undefined for a path that is not media. */
export function mediaMime(p: string): string | undefined {
  return own(MEDIA, extOf(p))?.mime
}

export const MEDIA_SCHEME = 'astera-media'
// The scheme is registered as standard (main/index.ts), so it needs a host; the path rides as one
// encoded segment after it. Encoding the whole path — separators and the drive colon too — keeps
// Chromium's URL normalisation from touching it: no `..` to fold, no backslash to turn around.
const PREFIX = `${MEDIA_SCHEME}://file/`

/** The URL the viewer loads `p` from. `version` (the file's mtime) goes in the query so a file
 *  regenerated under the same name is a different URL and the element reloads instead of showing the
 *  cached one; the protocol ignores the query. */
export function mediaUrl(p: string, version?: number): string {
  return PREFIX + encodeURIComponent(p) + (version === undefined ? '' : `?v=${Math.trunc(version)}`)
}

/** The absolute path a media URL names, or null when it is not one of ours. Never throws: the
 *  protocol handler answers a bad URL with an error status, not an exception. */
export function pathOfMediaUrl(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== `${MEDIA_SCHEME}:` || u.hostname !== 'file') return null
  const seg = u.pathname.replace(/^\//, '')
  if (seg === '') return null
  try {
    return decodeURIComponent(seg)
  } catch {
    return null
  }
}

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
export function mediaUrl(p: string, version?: number | string): string {
  if (version === undefined) return PREFIX + encodeURIComponent(p)
  const v = typeof version === 'number' ? String(Math.trunc(version)) : version
  return `${PREFIX}${encodeURIComponent(p)}?v=${encodeURIComponent(v)}`
}

export interface MediaStat {
  mtimeMs: number
  size: number
}

/** The URL version for a stat: mtime and size together, so a regenerated file that keeps one of the
 *  two (a coarse clock, an encoder that writes the same length) still gets a new URL. */
export function mediaVersion(st: MediaStat): string {
  return `${Math.trunc(st.mtimeMs)}-${st.size}`
}

const sameStat = (a: MediaStat | null, b: MediaStat | null): boolean =>
  a === null || b === null ? a === b : a.mtimeMs === b.mtimeMs && a.size === b.size

/** The viewer's reload bookkeeping. `loaded`: what is on screen (undefined before the first answer,
 *  null when the file was found missing). `pending`: a new stat seen once and waiting for a second
 *  look (undefined when nothing is pending). `lastSeq`: the newest check whose answer was applied. */
export interface ReloadState {
  loaded: MediaStat | null | undefined
  pending: MediaStat | null | undefined
  lastSeq: number
}

/** One check's answer, applied. A generator rewriting a clip in place (ffmpeg -y truncates, then
 *  writes for seconds) shows a different, half-written stat on every check until it is done, so a
 *  change — a new stat, or the file missing — is acted on only when two checks in a row agree on it:
 *  'reload' (load the new bytes) or 'gone' (say it cannot be opened). Until then the old picture
 *  stays. The first answer is acted on at once: nothing is on screen yet. `seq` numbers the checks in
 *  the order they were started; an answer older than (or the same as) the newest applied one is
 *  dropped, because a poll, a focus and a second click run concurrently and can answer out of order. */
export function reloadStep(
  s: ReloadState,
  seq: number,
  next: MediaStat | null
): { state: ReloadState; action: 'none' | 'reload' | 'gone' } {
  if (seq <= s.lastSeq) return { state: s, action: 'none' }
  const act = (): { state: ReloadState; action: 'reload' | 'gone' } => ({
    state: { loaded: next, pending: undefined, lastSeq: seq },
    action: next === null ? 'gone' : 'reload'
  })
  if (s.loaded === undefined) return act()
  if (sameStat(s.loaded, next)) return { state: { ...s, pending: undefined, lastSeq: seq }, action: 'none' }
  if (s.pending !== undefined && sameStat(s.pending, next)) return act()
  return { state: { ...s, pending: next, lastSeq: seq }, action: 'none' }
}

/** Where to resume after a reload: the old position when the new file still runs past it, else the
 *  start. A duration of Infinity (no known end yet) covers any position; NaN (not known at all)
 *  covers none. */
export function resumeAt(prevTime: number, duration: number): number {
  if (!Number.isFinite(prevTime) || prevTime < 0 || Number.isNaN(duration)) return 0
  return prevTime < duration ? prevTime : 0
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
